const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Docker = require('dockerode');
const tar = require('tar-stream');
const { v4: uuidv4 } = require('uuid');

const app = express();
const docker = new Docker();
const PORT = process.env.PORT || 3001;

// HTTP status codes
const HTTP_STATUS = {
  BAD_REQUEST: 400,
  INTERNAL_SERVER_ERROR: 500,
};

// Docker resource limits (configurable via environment variables)
// Can be updated at runtime via /config endpoint or per-request in /compile
let DOCKER_LIMITS = {
  MEMORY: Number(process.env.COMPILER_MEMORY_BYTES || 2147483648), // 2 GiB
  CPU_PERIOD: Number(process.env.COMPILER_CPU_PERIOD || 100000),
  CPU_QUOTA: Number(process.env.COMPILER_CPU_QUOTA || 200000),
};

// Default compilation timeout in milliseconds (configurable via env and /config)
let DEFAULT_COMPILE_TIMEOUT_MS = Number(process.env.COMPILER_TIMEOUT_MS || 60000);

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

/**
 * CONFIGURATION MAPPING
 * Defines how each framework behaves inside the Docker environment
 */
const FRAMEWORKS = {
  angular: {
    image: 'angular-compiler:latest',
    filePath: 'src/app/app.ts',
    distPath: '/workspace/template-app/dist/template-app',
    cacheHostPath: '/tmp/angular-cache',
    cacheContPath: '/workspace/template-app/.angular/cache',
    buildCmd: 'ng build --configuration production --output-hashing none --optimization true --source-map true --progress false',
  },
  react: {
    image: 'react-compiler:latest',
    filePath: 'src/App.tsx',
    distPath: '/workspace/template-app/dist',
    cacheHostPath: '/tmp/react-cache',
    cacheContPath: '/workspace/template-app/node_modules/.vite', // Vite caching
    buildCmd: 'npm run build',
  },
  vue: {
    image: 'vue-compiler:latest',
    filePath: 'src/App.vue',
    distPath: '/workspace/template-app/dist',
    cacheHostPath: '/tmp/vue-cache',
    cacheContPath: '/workspace/template-app/node_modules/.vite',
    buildCmd: 'npx vite build',
  },
};

/**
 * Health check endpoint
 * @param {Object} req - The request object
 * @param {Object} res - The response object
 * @returns {Object} A JSON object containing the status and service name
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'multi-compiler' });
});

/**
 * Get runtime configuration
 * @param {Object} res - The response object
 * @returns {Object} A JSON object containing the Docker resource limits and a note about the PUT endpoint
 */
app.get('/config', (_req, res) => {
  res.json({
    dockerLimits: { ...DOCKER_LIMITS },
    defaultCompileTimeoutMs: DEFAULT_COMPILE_TIMEOUT_MS,
    note: 'Use PUT /config to update these values at runtime',
  });
});

/**
 * Update runtime configuration
 * @param {Object} req - The request object
 * @param {Object} res - The response object
 * @returns {Object} A JSON object containing the updated Docker resource limits
 */
app.put('/config', (req, res) => {
  const { memory, cpuPeriod, cpuQuota, timeout } = req.body;

  if (timeout !== undefined) {
    const timeoutMs = Number(timeout);
    if (isNaN(timeoutMs) || timeoutMs <= 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Invalid timeout value. Must be a positive number (milliseconds)',
      });
    }
    DEFAULT_COMPILE_TIMEOUT_MS = timeoutMs;
  }

  if (memory !== undefined) {
    const memBytes = Number(memory);
    if (isNaN(memBytes) || memBytes <= 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Invalid memory value. Must be a positive number (bytes)',
      });
    }
    DOCKER_LIMITS.MEMORY = memBytes;
  }

  if (cpuPeriod !== undefined) {
    const period = Number(cpuPeriod);
    if (isNaN(period) || period <= 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Invalid cpuPeriod value. Must be a positive number',
      });
    }
    DOCKER_LIMITS.CPU_PERIOD = period;
  }

  if (cpuQuota !== undefined) {
    const quota = Number(cpuQuota);
    if (isNaN(quota) || quota <= 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Invalid cpuQuota value. Must be a positive number',
      });
    }
    DOCKER_LIMITS.CPU_QUOTA = quota;
  }

  res.json({
    success: true,
    message: 'Configuration updated',
    dockerLimits: { ...DOCKER_LIMITS },
    defaultCompileTimeoutMs: DEFAULT_COMPILE_TIMEOUT_MS,
  });
});

/**
 * Compiles the code
 * @param {Object} req - The request object
 * @param {Object} res - The response object
 * @returns {Object} A JSON object containing the success status, framework, files, and compilation time
 */
app.post('/compile', async (req, res) => {
  const {
    code,
    framework = 'angular',
    timeout,
    memory,
    cpuPeriod,
    cpuQuota,
  } = req.body;
  const compilationId = uuidv4();
  const config = FRAMEWORKS[framework.toLowerCase()];

  // Use per-request timeout or global default; validate
  const compileTimeoutMs = timeout !== undefined ? Number(timeout) : DEFAULT_COMPILE_TIMEOUT_MS;
  if (isNaN(compileTimeoutMs) || compileTimeoutMs <= 0) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: 'Invalid timeout value. Must be a positive number (milliseconds)',
    });
  }

  if (!config) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ success: false, error: `Unsupported framework: ${framework}` });
  }

  // Validate required code field first
  if (!code || typeof code !== 'string') {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ success: false, error: 'Invalid code provided' });
  }

  // Allow per-request resource limit overrides
  const resourceLimits = {
    memory: memory !== undefined ? Number(memory) : DOCKER_LIMITS.MEMORY,
    cpuPeriod:
      cpuPeriod !== undefined ? Number(cpuPeriod) : DOCKER_LIMITS.CPU_PERIOD,
    cpuQuota:
      cpuQuota !== undefined ? Number(cpuQuota) : DOCKER_LIMITS.CPU_QUOTA,
  };

  // Validate resource limits
  if (
    isNaN(resourceLimits.memory) ||
    resourceLimits.memory <= 0 ||
    isNaN(resourceLimits.cpuPeriod) ||
    resourceLimits.cpuPeriod <= 0 ||
    isNaN(resourceLimits.cpuQuota) ||
    resourceLimits.cpuQuota <= 0
  ) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error:
        'Invalid resource limits. memory, cpuPeriod, and cpuQuota must be positive numbers',
    });
  }

  console.log(`[${compilationId}] Starting ${framework} compilation...`);
  let container;
  const startTime = Date.now();

  try {

    container = await createCompilationContainer(
      compilationId,
      code,
      config,
      framework,
      resourceLimits,
    );
    console.log(`[${compilationId}] Container created (${framework})`);

    await container.start();
    const result = await waitForCompletion(container, compileTimeoutMs);

    if (!result.success) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `${framework.toUpperCase()} Build Failed`,
        logs: result.logs,
      });
    }

    const compiledFiles = await extractCompiledFiles(
      container,
      config.distPath,
    );
    const duration = Date.now() - startTime;

    console.log(`[${compilationId}] ✓ Compiled in ${duration}ms`);

    res.json({
      success: true,
      framework,
      files: compiledFiles,
      compilationTime: duration,
    });
  } catch (error) {
    console.error(`[${compilationId}] Error:`, error);
    res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json({ success: false, error: error.message });
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
      } catch (e) {
        console.error(`Cleanup error:`, e.message);
      }
    }
  }
});

/**
 * Creates a compilation container
 * @param {string} id - The id of the compilation
 * @param {string} userCode - The user's code to compile
 * @param {Object} config - The configuration for the compilation
 * @param {string} framework - The framework to compile
 * @param {Object} resourceLimits - Optional resource limits (memory, cpuPeriod, cpuQuota)
 * @returns {Promise<Docker.Container>} A promise that resolves to the created container
 */
async function createCompilationContainer(
  id,
  userCode,
  config,
  framework,
  resourceLimits = DOCKER_LIMITS,
) {
  // prepare the code for the specific framework
  const finalCode = framework === 'angular' ? prepareAngularCode(userCode) : userCode;
  const base64Code = Buffer.from(finalCode).toString('base64');

  // clear potential conflicting files
  const cleanupCmd =
    framework === 'vue'
      ? 'rm -f src/components/*.vue && '
      : framework === 'react'
        ? 'rm -f src/*.css src/App.tsx && '
        : framework === 'angular'
          ? 'rm -f src/app/app.ts src/app/app.component.html src/app/app.component.css && '
          : '';

  return await docker.createContainer({
    Image: config.image,
    name: `${framework}-compile-${id}`,
    Cmd: [
      '/bin/sh',
      '-c',
      `
cd /workspace/template-app
${cleanupCmd}
printf '%s' "${base64Code}" | base64 -d > ${config.filePath}
# Ensure the file timestamp is updated for Vite to pick up changes
touch ${config.filePath}
sync
${config.buildCmd} && echo "COMPILATION_COMPLETE"
`,
    ],
    HostConfig: {
      Binds: [`${config.cacheHostPath}:${config.cacheContPath}`],
      Memory: resourceLimits.memory ?? resourceLimits.MEMORY,
      CpuPeriod: resourceLimits.cpuPeriod ?? resourceLimits.CPU_PERIOD,
      CpuQuota: resourceLimits.cpuQuota ?? resourceLimits.CPU_QUOTA,
    },
    User: 'root',
  });
}

/**
 * Prepares the Angular code for compilation
 * @param {string} userCode - The user's code to prepare
 * @returns {string} The prepared code
 */
function prepareAngularCode(userCode) {
  let code = userCode;
  if (!code.includes('@angular/common')) {
    code = `import { CommonModule } from '@angular/common';\n${code}`;
  }
  code = code.replace(/selector:\s*['"].*?['"]/, "selector: 'app-root'");
  code = code.replace(/export class \w+/, 'export class AppComponent');
  if (!code.includes('standalone:')) {
    code = code.replace(/@Component\({/, `@Component({\n  standalone: true,`);
  }

  // Strip all external template/style references
  code = code.replace(/templateUrl:.*?,/g, '');
  code = code.replace(/styleUrls:.*?\],/g, '');
  code = code.replace(/styleUrl:.*?,/g, '');

  return code;
}

/**
 * Waits for the compilation to complete
 * @param {Docker.Container} container - The container to wait for
 * @param {number} timeout - The timeout in milliseconds
 * @returns {Promise<Object>} A promise that resolves to an object containing the success status and logs
 */
async function waitForCompletion(container, timeout) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      resolve({ success: false, error: 'Compilation timeout', logs: '' });
    }, timeout);

    (async () => {
      try {
        const waitResult = await container.wait();
        const logsBuffer = await container.logs({
          stdout: true,
          stderr: true,
          follow: false,
        });

        let cleanLogs = '';
        let offset = 0;
        while (offset < logsBuffer.length) {
          const length = logsBuffer.readUInt32BE(offset + 4);
          offset += 8;
          cleanLogs += logsBuffer.toString('utf8', offset, offset + length);
          offset += length;
        }

        clearTimeout(timeoutId);

        if (
          waitResult.StatusCode === 0 &&
          cleanLogs.includes('COMPILATION_COMPLETE')
        ) {
          resolve({ success: true, logs: cleanLogs });
        } else {
          resolve({ success: false, error: 'Build Failed', logs: cleanLogs });
        }
      } catch (error) {
        clearTimeout(timeoutId);
        resolve({ success: false, error: error.message, logs: '' });
      }
    })();
  });
}

/**
 * Extracts the compiled files from the container
 * @param {Docker.Container} container - The container to extract the files from
 * @param {string} distPath - The path to the compiled files
 * @returns {Promise<Object>} A promise that resolves to an object containing the compiled files
 */
async function extractCompiledFiles(container, distPath) {
  const files = {};
  try {
    const tarStream = await container.getArchive({ path: distPath });
    const extract = tar.extract();

    return new Promise((resolve, reject) => {
      extract.on('entry', (header, stream, next) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
          // Get just the filename, ignoring the path/subdirectories
          const filename = header.name.split('/').pop();

          // Only extract actual files (type 'file') that match our extensions
          if (header.type === 'file' && /\.(js|css|html|map)$/.test(filename)) {
            files[filename] = Buffer.concat(chunks).toString('utf8');
          }
          next();
        });
        stream.resume();
      });

      extract.on('finish', () => {
        console.log(`Extracted ${Object.keys(files).length} files from ${distPath}`);
        resolve(files);
      });

      extract.on('error', reject);
      tarStream.pipe(extract);
    });
  } catch (error) {
    console.error('Extraction Failed:', error.message);
    return {};
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Multi-Framework Compiler Service running on port ${PORT}`);
});
