# Antigravity Web UI Proxy (`ag-web`)

A secure, portable HTTP/2 proxy and headless launcher designed to enable developers to access an Antigravity IDE instance running on another machine remotely over the web using standard web browsers (e.g., via SSH port forwarding).

## Features

- **Headless Electron Execution**: Runs the Electron wrapper in headless mode, keeping the core application services running in the background for web browser access.
- **HTTP/2 & gRPC-Web Streaming**: Built on a custom HTTP/2 Node.js server (`proxy.js`) that supports frame multiplexing and gRPC trailers (essential for the Go language server communication).
- **Session Isolation**: Connects to the backend using dedicated connections for every stream/request, resolving Chrome connection reuse issues that stall new tabs and reloads.
- **Client-Side Storage Mocking**: Automatically injects a bridge for `window.nativeStorage` that maps Electron native storage calls to the browser's standard `localStorage`.
- **Initialization Race Condition Watchdog**: Fixes a race condition where the AppState stream initialization fires before React finishes mounting. A background BFS watchdog scans the React fiber tree to detect stale state caches and force-updates the render cycle automatically.
- **Lifecycle & Port Conflict Management**:
  - Automatically verifies if the selected port is busy before starting, preventing silent startup failures.
  - Cleans up background subprocesses, Named Pipes, and temporary listeners gracefully on script exit (`Ctrl+C`).

---

## Requirements

1. **Node.js** (detected automatically via `fnm` or standard `PATH`).
2. **Antigravity Package**: The launcher expects to find the `antigravity` Electron executable in `$HOME/Antigravity-x64/antigravity` or custom folders.

---

## Installation & Usage

### 1. Run the Startup Script
By default, the script starts on port `8080`. You can specify a different port as the first argument:

```bash
./start.sh [port]
```

### 2. Complete Google Authentication
Because the app runs headlessly in the background, the console will detect and print the Google OAuth authentication URL.
1. Open the URL in your browser.
2. Sign in with your account.
3. Copy the authorization code and paste it back into the terminal prompt.

### 3. Open the IDE
Once authenticated, open your browser and navigate to:
```
https://localhost:8080/
```
*(Accept the self-signed SSL certificate warning to proceed.)*

---

## Tips & Configurations

### Custom Antigravity Path
If your Antigravity package is installed in a custom directory, set the `ANTIGRAVITY_DIR` environment variable before running the script:

```bash
export ANTIGRAVITY_DIR="/path/to/your/Antigravity-folder"
./start.sh
```

### Trusting the Self-Signed Certificate
To avoid Chrome's security warning dialogs on load, you can add the generated certificate directly to your system's trusted NSS database:

```bash
certutil -d sql:$HOME/.pki/nssdb -A -t "P,," -n "Antigravity Local Dev" -i localhost-cert.pem
```

### Bypassing Chrome's "Not Secure" Badge
To treat this origin as fully secure and remove the "Not Secure" badge in the URL bar:
1. Open **`chrome://flags/#unsafely-treat-insecure-origin-as-secure`** in Chrome.
2. Enable the flag and enter your origin (e.g., `https://localhost:8080`) in the text box.
3. Relaunch Chrome.

---

## Repository Structure

- `start.sh`: Launcher script managing paths, port checks, authentication named pipe, and process cleanup.
- `proxy.js`: Native HTTP/2 proxy server handling gRPC headers, trailers, storage mocks, and the React watchdog.
