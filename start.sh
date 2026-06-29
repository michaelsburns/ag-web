#!/bin/bash

# Configuration
PROXY_PORT=${1:-8080}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PATH="$HOME/.config/Antigravity/logs/language_server.log"
KEY_FILE="$SCRIPT_DIR/localhost-key.pem"
CERT_FILE="$SCRIPT_DIR/localhost-cert.pem"

# Locate Node binary
NODE_BIN="node"
if ! command -v node &>/dev/null; then
  # Find the latest FNM node version dynamically if present
  if [ -d "$HOME/.local/share/fnm/node-versions" ]; then
    LATEST_FNM_NODE=$(find "$HOME/.local/share/fnm/node-versions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)
    if [ -n "$LATEST_FNM_NODE" ] && [ -x "$LATEST_FNM_NODE/installation/bin/node" ]; then
      NODE_BIN="$LATEST_FNM_NODE/installation/bin/node"
    fi
  fi
  
  if [ "$NODE_BIN" = "node" ] && [ -x "$HOME/.local/bin/fnm" ]; then
    eval "$("$HOME/.local/bin/fnm" env)"
  fi
fi

# Find Antigravity executable
ANTIGRAVITY_BIN=""
if [ -f "$SCRIPT_DIR/antigravity" ]; then
  ANTIGRAVITY_BIN="$SCRIPT_DIR/antigravity"
elif [ -n "$ANTIGRAVITY_DIR" ] && [ -f "$ANTIGRAVITY_DIR/antigravity" ]; then
  ANTIGRAVITY_BIN="$ANTIGRAVITY_DIR/antigravity"
elif [ -f "$HOME/Antigravity-x64/antigravity" ]; then
  ANTIGRAVITY_BIN="$HOME/Antigravity-x64/antigravity"
elif [ -f "$HOME/Antigravity/antigravity" ]; then
  ANTIGRAVITY_BIN="$HOME/Antigravity/antigravity"
fi

if [ -z "$ANTIGRAVITY_BIN" ]; then
  echo "ERROR: Could not find the 'antigravity' executable!"
  echo "Please place the 'antigravity' executable in the script directory, $HOME/Antigravity-x64, or set ANTIGRAVITY_DIR."
  exit 1
fi

# Check if the port is busy using Node.js
PORT_BUSY=$("$NODE_BIN" -e "
const net = require('net');
const server = net.createServer();
server.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('true');
  }
  process.exit(0);
});
server.once('listening', () => {
  server.close();
  console.log('false');
  process.exit(0);
});
server.listen($PROXY_PORT);
")

if [ "$PORT_BUSY" = "true" ]; then
  echo "ERROR: Port $PROXY_PORT is already in use by another process!"
  echo "Please free the port or specify a different one: ./start.sh [port]"
  exit 1
fi

# Clean up function to terminate all spawned child processes
cleanup() {
  echo ""
  echo "Shutting down all Antigravity processes..."
  
  # Remove traps to prevent infinite recursion
  trap - SIGINT SIGTERM EXIT
  
  # Kill all child processes of this script's PID
  pkill -P $$ 2>/dev/null
  
  # Explicitly kill any spawned Antigravity and Language Server binaries
  pkill -f "resources/bin/language_server" 2>/dev/null
  pkill -f "antigravity" 2>/dev/null
  pkill -f "tail -f $SCRIPT_DIR/.stdin_pipe" 2>/dev/null
  
  # Clean up the named pipe
  rm -f "$SCRIPT_DIR/.stdin_pipe"
  exit 0
}

# Trap Ctrl+C (SIGINT), terminations (SIGTERM), and general script exit
trap cleanup SIGINT SIGTERM EXIT

echo "Cleaning up any old Antigravity or proxy processes..."
pkill -f "resources/bin/language_server" 2>/dev/null
pkill -f "antigravity" 2>/dev/null
pkill -f "proxy.js" 2>/dev/null
pkill -f "tail -f $SCRIPT_DIR/.stdin_pipe" 2>/dev/null

# Generate self-signed certificate if they don't exist
if [ ! -f "$KEY_FILE" ] || [ ! -f "$CERT_FILE" ]; then
  echo "Generating self-signed SSL certificate for localhost..."
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' \
    -addext "subjectAltName = DNS:localhost,IP:127.0.0.1" \
    -keyout "$KEY_FILE" -out "$CERT_FILE" -days 365 2>/dev/null
fi

# Clear the old log file so we detect the new port cleanly
rm -f "$LOG_PATH"

# Create named pipe for stdin forwarding
rm -f "$SCRIPT_DIR/.stdin_pipe"
mkfifo "$SCRIPT_DIR/.stdin_pipe"

echo "Starting Antigravity (Electron) in headless mode using: $ANTIGRAVITY_BIN"
tail -f "$SCRIPT_DIR/.stdin_pipe" | ELECTRON_OZONE_PLATFORM_HINT=headless "$ANTIGRAVITY_BIN" --remote-debugging-port=9222 >/dev/null 2>&1 &
ELECTRON_PID=$!

echo "Waiting for language server to initialize..."
AUTH_PROMPTED=false
for i in {1..40}; do
  if [ -f "$LOG_PATH" ]; then
    # 1. Check if we need authentication (and haven't prompted yet)
    if [ "$AUTH_PROMPTED" = false ] && grep -q "Please visit the following URL to authorize" "$LOG_PATH"; then
      URL=$("$NODE_BIN" -e "const fs = require('fs'); const content = fs.readFileSync('$LOG_PATH', 'utf8'); const match = content.match(/https:\\/\\/accounts\\.google\\.com\\/o\\/oauth2\\/auth\\?[^\\s\\u001b]+/); if (match) console.log(match[0]);")
      
      if [ -n "$URL" ]; then
        AUTH_PROMPTED=true
        echo ""
        echo "============================================================"
        echo " 🔑 ACTION REQUIRED: Google Authentication"
        echo "============================================================"
        echo "Please open the following link in your browser to log in:"
        echo ""
        echo "$URL"
        echo ""
        echo -n "Paste the authorization code here and press Enter: "
        read -r AUTH_CODE
        
        if [ -n "$AUTH_CODE" ]; then
          echo "$AUTH_CODE" > "$SCRIPT_DIR/.stdin_pipe"
          echo "Sending code to Antigravity..."
          # Reset loop counter to give it more time to initialize after auth
          i=1
        else
          echo "No code entered. Aborting."
          cleanup
        fi
      fi
    fi

    # 2. Check if authentication succeeded
    if grep -q "Auth succeeded" "$LOG_PATH"; then
      echo "Authentication successful!"
      break
    fi
  fi
  sleep 1
done

# Start the HTTP/2 proxy (which runs in the foreground and auto-detects the port)
PORT=$PROXY_PORT "$NODE_BIN" "$SCRIPT_DIR/proxy.js"
