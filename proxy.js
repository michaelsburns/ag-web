const http2 = require('http2');
const fs = require('fs');
const path = require('path');

const os = require('os');
const PROXY_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const LS_LOG_PATH = path.join(os.homedir(), '.config/Antigravity/logs/language_server.log');
const PROXY_LOG_PATH = path.join(os.homedir(), '.config/Antigravity/logs/proxy.log');
const KEY_FILE = path.join(__dirname, 'localhost-key.pem');
const CERT_FILE = path.join(__dirname, 'localhost-cert.pem');

// Set up directory and log stream
const logDir = path.dirname(PROXY_LOG_PATH);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logStream = fs.createWriteStream(PROXY_LOG_PATH, { flags: 'a' });

let cachedPort = null;
let streamCounter = 0;

function getTimestamp() {
  return new Date().toISOString().split('T')[1].slice(0, -1); // e.g. "15:04:07.123"
}

function log(sid, ...args) {
  const prefix = sid ? `[Stream #${sid}]` : '[System]';
  const msg = `[${getTimestamp()}] [Proxy-H2] ${prefix} ` + args.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
  logStream.write(msg + '\n');
}

function logErr(sid, ...args) {
  const prefix = sid ? `[Stream #${sid}]` : '[System]';
  const msg = `[${getTimestamp()}] [Proxy-H2] ${prefix} ERROR: ` + args.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
  logStream.write(msg + '\n');
}

function getHTTPSPort(forceRefresh = false) {
  if (cachedPort && !forceRefresh) {
    return cachedPort;
  }
  try {
    if (!fs.existsSync(LS_LOG_PATH)) {
      logErr(null, `Warning: Language server log file not found at ${LS_LOG_PATH}`);
      return null;
    }
    const content = fs.readFileSync(LS_LOG_PATH, 'utf8');
    const matches = [...content.matchAll(/Language server listening on random port at (\d+) for HTTPS/g)];
    if (matches.length > 0) {
      const port = parseInt(matches[matches.length - 1][1], 10);
      if (port !== cachedPort) {
        log(null, `Detected Antigravity running on HTTPS port: ${port}`);
        cachedPort = port;
      }
      return port;
    }
  } catch (e) {
    logErr(null, 'Error reading log file:', e.message);
  }
  return null;
}

const STORAGE_MOCK_SCRIPT = `
<!-- Antigravity Web UI Storage Bridge Mock -->
<script>
(function() {
  console.log("[Mock] Injecting nativeStorage and Electron preload bridges...");
  
  window.nativeStorage = {
    async getItems() {
      console.log("[Mock] getItems() called");
      const items = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        try {
          items[key] = JSON.parse(localStorage.getItem(key));
        } catch (e) {
          items[key] = localStorage.getItem(key);
        }
      }
      console.log("[Mock] getItems() returning:", items);
      return items;
    },
    async updateItems(changes) {
      console.log("[Mock] updateItems() called with changes:", changes);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) {
          localStorage.removeItem(key);
        } else {
          localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
      }
      if (this._listeners) {
        for (const cb of this._listeners) {
          try { cb(changes); } catch(e) {}
        }
      }
    },
    onChanged(callback) {
      if (!this._listeners) this._listeners = [];
      this._listeners.push(callback);
      return () => {
        this._listeners = this._listeners.filter(cb => cb !== callback);
      };
    }
  };

  window.nativeNotifications = {
    async send(options) {
      console.log("[Mock] Notification:", options);
      if (window.Notification && Notification.permission === "granted") {
        new Notification(options.title, { body: options.body });
      }
    },
    async openSystemPreferences() {
      console.log("[Mock] openSystemPreferences");
    },
    onClicked(callback) {
      return () => {};
    }
  };

  window.electronUpdater = {
    onStateChanged(callback) { return () => {}; },
    async getState() { return { type: "idle" }; },
    async applyUpdate() {},
    async quitAndInstall() {},
    async checkForUpdates() {}
  };

  window.dialog = {
    async showOpenDialog() {
      const path = prompt("Enter the absolute path of the folder you want to open:");
      return path && path.trim() ? path.trim() : null;
    }
  };

  window.logs = {
    async getElectronLogs() { return []; }
  };

  window.extensions = {
    async sendAuthorities(authoritiesMap) {}
  };

  window.deepLink = {
    onDeepLink(callback) { return () => {}; },
    async getStoredDeepLink() { return ""; }
  };

  window.agent = {
    async updateActiveAgentCount(count) {}
  };

  window.electronNative = {
    getZoomLevel() { return 1.0; },
    async setTitleBarOverlay(options) {},
    async minimize() {},
    async maximize() {},
    async unmaximize() {},
    async isMaximized() { return false; },
    async close() {},
    async toggleDevTools() {},
    zoomIn() {},
    zoomOut() {},
    resetZoom() {},
    async openExternal(url) { console.log("[Mock] openExternal:", url); }
  };

  window.ide = {
    async isInstalled() { return false; }
  };
})();
</script>
` +
// Initialization race condition watchdog:
// The React app's iWa component returns null when initialized===false.
// Due to a race condition, the gRPC state stream can fire before React
// subscribes its event listener, leaving the page permanently blank.
// This watchdog detects that condition and forces a re-render.
`
<script>
(function() {
  console.log("[Watchdog] Initialization race condition watchdog active.");
  var WATCHDOG_INTERVAL = 500;
  var WATCHDOG_MAX_CHECKS = 20; // 10 seconds max
  var checks = 0;
  var timer = setInterval(function() {
    checks++;
    var root = document.getElementById("root");
    if (!root) return;

    // If root has meaningful React-rendered content, app is working
    var hasContent = root.children.length > 0 &&
      (root.querySelector('[data-testid]') || root.querySelector('nav') ||
       root.querySelector('main') || root.querySelector('[class]'));
    if (hasContent) {
      console.log("[Watchdog] App rendered. Stopping. (check #" + checks + ")");
      clearInterval(timer);
      return;
    }

    if (checks > WATCHDOG_MAX_CHECKS) {
      console.log("[Watchdog] Max checks reached. Stopping.");
      clearInterval(timer);
      return;
    }

    // Find the React fiber root
    var containerKey = Object.keys(root).find(function(k) {
      return k.startsWith("__reactContainer$");
    });
    if (!containerKey) {
      console.log("[Watchdog] Check #" + checks + ": No React fiber yet.");
      return;
    }
    var fiberRoot = root[containerKey];
    if (!fiberRoot || !fiberRoot.child) {
      console.log("[Watchdog] Check #" + checks + ": Fiber root has no child.");
      return;
    }

    console.log("[Watchdog] Check #" + checks + ": React mounted but root empty. Scanning fibers...");

    // Walk straight down the child chain (providers are linear)
    // then also check siblings at each level
    var queue = [fiberRoot.child];
    var visited = 0;
    while (queue.length > 0 && visited < 200) {
      var node = queue.shift();
      if (!node) continue;
      visited++;

      // Add children and siblings to queue for BFS
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);

      // We're looking for a fiber with hooks that has child === null
      if (node.child !== null || !node.memoizedState) continue;

      // Walk the hooks linked list looking for a vha-like cache object
      var hook = node.memoizedState;
      var hookIdx = 0;
      while (hook && hookIdx < 20) {
        var ms = hook.memoizedState;
        if (ms && Array.isArray(ms) && ms.length === 2 && ms[0] &&
            typeof ms[0] === "object" && "_providerState" in ms[0] &&
            "_resultCache" in ms[0] &&
            ms[0]._providerState &&
            "initialized" in ms[0]._providerState) {

          console.log("[Watchdog] Found vha at hook " + hookIdx +
            ", initialized=" + ms[0]._providerState.initialized);

          if (ms[0]._providerState.initialized === false) {
            // Found stale cache! Look for the provider in useMemo deps
            var searchHook = node.memoizedState;
            var provider = null;
            var siHook = 0;
            while (searchHook && siHook < 20) {
              var sms = searchHook.memoizedState;
              if (sms && Array.isArray(sms) && sms.length === 2 &&
                  Array.isArray(sms[1])) {
                // Check deps for a provider object
                for (var di = 0; di < sms[1].length; di++) {
                  var dep = sms[1][di];
                  if (dep && typeof dep === "object" &&
                      typeof dep.getState === "function" &&
                      typeof dep.onDidChange === "function") {
                    var testState = dep.getState();
                    if (testState && "initialized" in testState && testState.initialized === true) {
                      provider = dep;
                      break;
                    }
                  }
                }
                if (provider) break;
              }
              searchHook = searchHook.next;
              siHook++;
            }

            if (provider) {
              var liveState = provider.getState();
              console.log("[Watchdog] RACE CONDITION DETECTED! Live state:", JSON.stringify(liveState));
              // Fix the stale cache
              ms[0]._providerState = liveState;
              if (ms[0]._argsCache) {
                ms[0]._computeAndUpdateResultCache(ms[0]._argsCache);
              }
              // Find useState dispatch for force-update
              var fuHook = node.memoizedState;
              var fuIdx = 0;
              while (fuHook && fuIdx < 20) {
                if (fuHook.queue && fuHook.queue.dispatch &&
                    typeof fuHook.queue.dispatch === "function" &&
                    !fuHook.queue.lastRenderedReducer) {
                  // This looks like a force-update useState (reducer-less)
                  console.log("[Watchdog] Dispatching force re-render via hook " + fuIdx);
                  fuHook.queue.dispatch({});
                  clearInterval(timer);
                  return;
                }
                // Also try hooks with a basic reducer
                if (fuHook.queue && fuHook.queue.dispatch &&
                    typeof fuHook.queue.dispatch === "function") {
                  console.log("[Watchdog] Dispatching force re-render via hook " + fuIdx + " (with reducer)");
                  fuHook.queue.dispatch({});
                  clearInterval(timer);
                  return;
                }
                fuHook = fuHook.next;
                fuIdx++;
              }
              // Fallback: if we can't find a dispatch, just reload
              console.log("[Watchdog] Could not find dispatch. Reloading page...");
              clearInterval(timer);
              window.location.reload();
              return;
            } else {
              console.log("[Watchdog] Stale vha found but no live provider. Will retry...");
            }
          }
          break; // Found the vha, no need to check more hooks
        }
        hook = hook.next;
        hookIdx++;
      }
    }
    console.log("[Watchdog] Scanned " + visited + " fiber nodes. No actionable stale state found yet.");
  }, WATCHDOG_INTERVAL);
})();
</script>
`;
let sharedAssetClient = null;
let sharedAssetClientPort = null;

function getSharedAssetClient(port) {
  if (sharedAssetClient && sharedAssetClientPort === port && !sharedAssetClient.destroyed && !sharedAssetClient.closed) {
    return sharedAssetClient;
  }
  if (sharedAssetClient) {
    log(null, `Port changed from ${sharedAssetClientPort} to ${port}. Destroying old shared asset client.`);
    sharedAssetClient.destroy();
  }
  log(null, `Connecting shared asset backend client to port ${port}...`);
  sharedAssetClientPort = port;
  sharedAssetClient = http2.connect(`https://127.0.0.1:${port}`, {
    rejectUnauthorized: false
  });
  sharedAssetClient.on('error', (err) => {
    logErr(null, '[Shared Asset Client] error:', err.message);
    sharedAssetClient.destroy();
    sharedAssetClient = null;
    sharedAssetClientPort = null;
  });
  sharedAssetClient.on('close', () => {
    log(null, '[Shared Asset Client] closed');
    sharedAssetClient = null;
    sharedAssetClientPort = null;
  });
  return sharedAssetClient;
}

const server = http2.createSecureServer({
  key: fs.readFileSync(KEY_FILE),
  cert: fs.readFileSync(CERT_FILE)
});

server.on('session', (session) => {
  const sid = session.socket ? `${session.socket.remoteAddress}:${session.socket.remotePort}` : 'Unknown';
  log(null, `[Session ${sid}] New browser HTTP/2 session established`);
});

server.on('stream', (stream, headers) => {
  const sid = ++streamCounter;
  const startTime = Date.now();
  const path = headers[':path'].split('?')[0];
  const method = headers[':method'];



  function logDiag(msg, ...args) {
    const elapsed = Date.now() - startTime;
    let windowInfo = '';
    if (stream.session && stream.session.state) {
      windowInfo = ` [Session Window: ${stream.session.state.localWindowSize} / Remote: ${stream.session.state.remoteWindowSize}]`;
    }
    log(sid, `+${elapsed}ms${windowInfo} ${msg}`, ...args);
  }

  // Buffer request body chunks immediately to prevent race conditions
  let bufferedChunks = [];
  let browserRequestEnded = false;
  let proxyReqRef = null;

  stream.on('data', (chunk) => {
    logDiag(`Buffered request chunk: ${chunk.length} bytes`);
    if (proxyReqRef) {
      if (!proxyReqRef.destroyed && !proxyReqRef.closed) {
        proxyReqRef.write(chunk);
      }
    } else {
      bufferedChunks.push(chunk);
    }
  });

  stream.on('end', () => {
    logDiag('Browser request ended');
    browserRequestEnded = true;
    if (proxyReqRef) {
      if (!proxyReqRef.destroyed && !proxyReqRef.closed) {
        proxyReqRef.end();
      }
    }
  });

  logDiag(`Request: ${method} ${path}`);
  logDiag(`Headers:`, headers);

  const targetPort = getHTTPSPort();
  if (!targetPort) {
    logErr(sid, 'Failed: target port not found');
    stream.respond({ ':status': 503, 'content-type': 'text/plain' });
    stream.end('Service Unavailable: Backend port not found.');
    return;
  }

  // Detect gRPC requests
  const isGrpc = path.startsWith('/exa.language_server_pb.LanguageServerService/') || 
                 (headers['content-type'] && headers['content-type'].includes('grpc'));

  let clientConn;
  if (isGrpc) {
    logDiag(`Connecting dedicated backend client for gRPC stream...`);
    clientConn = http2.connect(`https://127.0.0.1:${targetPort}`, {
      rejectUnauthorized: false
    });
    clientConn.on('error', (err) => {
      logErr(sid, '[Backend Client] error:', err.message);
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEOUT') {
        logDiag('Connection refused. Invalidating cached port.');
        cachedPort = null;
      }
      clientConn.destroy();
    });
  } else {
    clientConn = getSharedAssetClient(targetPort);
  }

  // Clone headers and remove connection-specific HTTP/1 headers
  const reqHeaders = { ...headers };
  delete reqHeaders[':authority'];
  delete reqHeaders['connection'];
  delete reqHeaders['keep-alive'];
  delete reqHeaders['proxy-connection'];
  delete reqHeaders['transfer-encoding'];

  // Only disable compression for HTML requests to allow mock injection.
  // This includes the root, index.html, and extensionless SPA routes (e.g., /c/...)
  const isHtmlRequest = method === 'GET' && 
    (!path.includes('.') || (headers['accept'] && headers['accept'].includes('text/html')));
  if (isHtmlRequest) {
    delete reqHeaders['accept-encoding'];
  }

  reqHeaders[':authority'] = `127.0.0.1:${targetPort}`;

  let finished = false;
  const proxyReq = clientConn.request(reqHeaders);
  proxyReqRef = proxyReq; // Bind reference so future stream chunks flow directly
  logDiag('Forward request sent to backend');

  // Flush any buffered chunks to the backend request
  if (bufferedChunks.length > 0) {
    logDiag(`Flushing ${bufferedChunks.length} buffered request chunks to backend`);
    for (const chunk of bufferedChunks) {
      if (!proxyReq.destroyed && !proxyReq.closed) {
        proxyReq.write(chunk);
      }
    }
    bufferedChunks = [];
  }
  if (browserRequestEnded) {
    if (!proxyReq.destroyed && !proxyReq.closed) {
      proxyReq.end();
    }
  }

  proxyReq.on('response', (responseHeaders) => {
    logDiag(`Backend responded with status: ${responseHeaders[':status']}`);
    logDiag(`Backend Response Headers:`, responseHeaders);
    
    const resHeaders = { ...responseHeaders };
    delete resHeaders['access-control-allow-origin'];
    delete resHeaders['access-control-allow-credentials'];
    delete resHeaders['access-control-allow-headers'];
    delete resHeaders['access-control-allow-methods'];
    delete resHeaders['access-control-expose-headers'];

    const contentType = resHeaders['content-type'] || '';
    const isHtml = contentType.includes('text/html');

    if (isHtml) {
      logDiag('Response identified as HTML. Injecting storage mock.');
      delete resHeaders['content-encoding'];

      let body = '';
      proxyReq.on('data', (chunk) => {
        body += chunk;
      });
      proxyReq.on('end', () => {
        let injectedBody = body
          .replace('<head>', '<head>' + STORAGE_MOCK_SCRIPT)
          .replace('<div id="root"></div>', `<div id="root" style="display:flex;align-items:center;justify-content:center;height:100vh;color:#9ca3af;font-family:system-ui,-apple-system,sans-serif;font-size:1.1rem;flex-direction:column;gap:1.2rem;background-color:#0e1318;"><div style="width:2.5rem;height:2.5rem;border:3px solid #374151;border-top-color:#3b82f6;border-radius:50%;animation:spin 1s linear infinite;"></div><div style="font-weight:500;letter-spacing:0.025em;">Loading Antigravity Workspace...</div><style>@keyframes spin{to{transform:rotate(360deg);}}</style></div>`);
        resHeaders['content-length'] = Buffer.byteLength(injectedBody);
        
        logDiag(`Writing modified HTML (length: ${resHeaders['content-length']})`);
        stream.respond(resHeaders);
        stream.end(injectedBody);
      });
    } else {
      logDiag('Sending response headers to browser');
      stream.respond(resHeaders);

      // Manually forward response body chunks
      proxyReq.on('data', (chunk) => {
        logDiag(`Forwarding response chunk: ${chunk.length} bytes`);
        if (!stream.destroyed && !stream.closed) {
          stream.write(chunk);
        }
      });

      proxyReq.on('end', () => {
        logDiag('Backend response ended');
        if (!stream.destroyed && !stream.closed) {
          stream.end();
        }
      });
    }
  });

  proxyReq.on('trailers', (trailers) => {
    logDiag(`Forwarding gRPC trailers:`, trailers);
    if (!stream.destroyed && !stream.closed) {
      stream.sendTrailers(trailers);
    }
  });

  // Cleanup helper
  function cleanup() {
    if (!finished) {
      finished = true;
      logDiag('Cleaning up stream');
      proxyReq.destroy();
      if (isGrpc && clientConn) {
        logDiag('Destroying dedicated gRPC backend connection');
        clientConn.destroy();
      }
    }
  }

  proxyReq.on('end', () => {
    logDiag('[Backend] ended');
    cleanup();
  });

  proxyReq.on('close', () => {
    logDiag('[Backend] closed');
    cleanup();
  });

  stream.on('close', () => {
    logDiag('[Browser] closed');
    cleanup();
  });

  proxyReq.on('error', (err) => {
    logErr(sid, '[Backend] error:', err.message);
    if (!stream.destroyed && !stream.closed) {
      stream.destroy();
    }
    cleanup();
  });

  stream.on('error', (err) => {
    logErr(sid, '[Browser] error:', err.message);
    cleanup();
  });
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  log(null, `============================================================`);
  log(null, `  Antigravity HTTP/2 Web UI Proxy running at:`);
  log(null, `  https://localhost:${PROXY_PORT}/`);
  log(null, `============================================================`);
  getHTTPSPort(); // Initial port check
});
