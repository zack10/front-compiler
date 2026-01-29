const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Docker = require('dockerode');
const tar = require('tar-stream');
const { v4: uuidv4 } = require('uuid');

const app = express();
const docker = new Docker();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

/**
 * CONFIGURATION MAPPING
 * Defines how each framework behaves inside the Docker environment
 */
const FRAMEWORKS = {
  angular: {
    image: 'angular-compiler:latest',
    // Change this from app.component.ts to app.ts
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
 * Compiles the code
 * @param {Object} req - The request object
 * @param {Object} res - The response object
 * @returns {Object} A JSON object containing the success status, framework, files, and compilation time
 */
app.post('/compile', async (req, res) => {
  const { code, framework = 'angular', timeout = 60000 } = req.body;
  const compilationId = uuidv4();
  const config = FRAMEWORKS[framework.toLowerCase()];

  if (!config) {
    return res
      .status(400)
      .json({ success: false, error: `Unsupported framework: ${framework}` });
  }

  console.log(`[${compilationId}] Starting ${framework} compilation...`);
  let container;
  const startTime = Date.now();

  try {
    if (!code || typeof code !== 'string') {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid code provided' });
    }

    container = await createCompilationContainer(
      compilationId,
      code,
      config,
      framework,
    );
    console.log(`[${compilationId}] Container created (${framework})`);

    await container.start();
    const result = await waitForCompletion(container, timeout);

    if (!result.success) {
      return res.status(400).json({
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
    res.status(500).json({ success: false, error: error.message });
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
 * @returns {Promise<Docker.Container>} A promise that resolves to the created container
 */
async function createCompilationContainer(
  id,
  userCode,
  config,
  framework,
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
echo "${base64Code}" | base64 -d > ${config.filePath}
# Ensure the file timestamp is updated for Vite to pick up changes
touch ${config.filePath}
sync
${config.buildCmd} && echo "COMPILATION_COMPLETE"
`,
    ],
    HostConfig: {
      Binds: [`${config.cacheHostPath}:${config.cacheContPath}`],
      Memory: 2147483648,
      CpuPeriod: 100000,
      CpuQuota: 200000,
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
  return new Promise(async (resolve) => {
    const timeoutId = setTimeout(() => {
      resolve({ success: false, error: 'Compilation timeout', logs: '' });
    }, timeout);

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
