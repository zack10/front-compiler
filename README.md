## Front Compiler

Multi-framework code compiler service for **Angular**, **React**, and **Vue**.  
It exposes a simple HTTP API that accepts source code, compiles it inside isolated Docker containers, and returns the built assets (HTML, JS, CSS, sourcemaps).

### Features

- **Single API**: `/compile` endpoint that works for `angular`, `react`, and `vue`.
- **Isolated builds**: Each compilation runs in its own Docker container.
- **Cached builds**: Uses host-mounted caches for faster subsequent compiles.
- **Health check**: `/health` endpoint to verify the service is running.

### Project Structure

- `compiler-service/`
  - `server.js` – Express server exposing the HTTP API and talking to Docker.
  - `package.json` – Runtime dependencies (no build tooling here).
- `Dockerfile.compiler-service` – Builds the API image.
- `Dockerfile.angular-compiler` – Template app image for Angular compilations.
- `Dockerfile.react-compiler` – Template app image for React compilations.
- `Dockerfile.vue-compiler` – Template app image for Vue compilations.
- `docker-compose.yml` – Orchestrates the compiler API and build images.

### Requirements

- Docker (with access to `/var/run/docker.sock`)
- Docker Compose v3.8+
- Node.js runtime is inside the Docker images; not required on the host except for development.

### Getting Started

#### 1. Build images

From the project root:

```bash
docker compose build
```

This builds:

- `compiler-service` (main API)
- `angular-compiler`
- `react-compiler`
- `vue-compiler`

#### 2. Run the compiler service

```bash
docker compose up -d compiler-service
```

The service will be available on `http://localhost:3001`.

Check health:

```bash
curl http://localhost:3001/health
```

Expected response:

```json
{ "status": "ok", "service": "multi-compiler" }
```

### API

#### `POST /compile`

**Body (JSON):**

```json
{
  "code": "/* your framework-specific source code here */",
  "framework": "angular",
  "timeout": 60000
}
```

- **code**: Required. String of the component/app source.
- **framework**: Optional. One of `"angular"`, `"react"`, `"vue"`. Defaults to `"angular"`.
- **timeout**: Optional. Milliseconds before the build is treated as failed (default from server).

**Response (success):**

```json
{
  "success": true,
  "framework": "angular",
  "files": {
    "index.html": "<!doctype html>...",
    "main.js": "(()=>{...})();",
    "styles.css": "body{...}",
    "main.js.map": "{...}"
  },
  "compilationTime": 1234
}
```

**Response (error):**

```json
{
  "success": false,
  "error": "ANGULAR Build Failed",
  "logs": "full docker build logs here..."
}
```

### Framework-specific behavior

- **Angular**
  - Image: `angular-compiler:latest`
  - Writes user code to `src/app/app.ts`.
  - Uses `ng build --configuration production --output-hashing none --optimization true --source-map true`.
  - Automatically:
    - Ensures `CommonModule` import.
    - Normalizes component selector to `app-root`.
    - Renames component class to `AppComponent`.
    - Forces `standalone: true`.
    - Strips `templateUrl` / `styleUrls` so everything is inline.

- **React**
  - Image: `react-compiler:latest`
  - Writes user code to `src/App.tsx`.
  - Runs `npm run build` inside the template app.

- **Vue**
  - Image: `vue-compiler:latest`
  - Writes user code to `src/App.vue`.
  - Runs `npx vite build`.

### Caching

To speed up repeated builds, Docker volumes are mounted:

- `/tmp/angular-cache` ↔ Angular CLI cache
- `/tmp/react-cache` ↔ React/Vite cache
- `/tmp/vue-cache` ↔ Vue/Vite cache

These paths are defined in `docker-compose.yml` and in `FRAMEWORKS` in `server.js`.

### Development

- Main server entrypoint: `compiler-service/server.js`
- Port: `3001` (configurable via `PORT` environment variable).
- You can run the service directly from the `compiler-service` folder if you install Node.js locally, but the recommended path is via Docker Compose to ensure Docker access and consistent runtime.
