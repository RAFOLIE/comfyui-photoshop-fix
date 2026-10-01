let socket = null;
let listeners = {};
const clinetid = generateClientId();

// Store IP address received from plugin
let pluginServerAddress = null;
let pluginProtocol = null;

// Listen for messages from plugin main process (UXP)
window.addEventListener("message", (event) => {
  try {
    // Check if message contains server address info
    if (event.data && typeof event.data === 'object') {
      if (event.data.type === 'serverAddress' || event.data.serverAddress) {
        const address = event.data.serverAddress || event.data;
        if (address.hostname || address.host) {
          pluginServerAddress = {
            hostname: address.hostname || address.host,
            port: address.port || '8188'
          };
          pluginProtocol = address.protocol || 'http';
          console.log('🔹 Received server address from plugin:', pluginServerAddress);
          // Reconnect if socket exists but is not connected
          if (socket && socket.readyState !== WebSocket.OPEN) {
            socket.close();
            socket = null;
            setTimeout(connect, 1000);
          }
        }
      }
    }
    // Also check for URL string in message
    else if (typeof event.data === 'string' && (event.data.startsWith('http://') || event.data.startsWith('https://'))) {
      try {
        const url = new URL(event.data);
        pluginServerAddress = {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? '443' : '80')
        };
        pluginProtocol = url.protocol === 'https:' ? 'https' : 'http';
        console.log('🔹 Received server URL from plugin:', pluginServerAddress);
        if (socket && socket.readyState !== WebSocket.OPEN) {
          socket.close();
          socket = null;
          setTimeout(connect, 1000);
        }
      } catch (e) {
        // Not a valid URL, ignore
      }
    }
  } catch (e) {
    // Ignore errors in message handling
  }
});

// Function to get the correct hostname and port
function getServerAddress() {
  // Priority 1: Use address received from plugin main process
  if (pluginServerAddress) {
    return pluginServerAddress;
  }

  // Priority 2: Try to get from URL parameters
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const customHost = urlParams.get('host');
    const customPort = urlParams.get('port');

    if (customHost && customPort) {
      return { hostname: customHost, port: customPort };
    }
  } catch (e) {
    // window.location might not be available
  }

  // Priority 3: Try to get from localStorage (set by plugin)
  try {
    const storedIP = localStorage.getItem('comfyui_ps_ip');
    const storedPort = localStorage.getItem('comfyui_ps_port');
    if (storedIP && storedPort) {
      return { hostname: storedIP, port: storedPort };
    }
  } catch (e) {
    console.warn("Could not read from localStorage:", e);
  }

  // Priority 4: Fallback to window.location (for webview with correct URL)
  try {
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    return { hostname: window.location.hostname, port: port };
  } catch (e) {
    // If window.location is not available, use default
    console.warn("window.location not available, using default");
    return { hostname: '127.0.0.1', port: '8188' };
  }
}

// Function to get the protocol (http or https)
function getProtocol() {
  // Priority 1: Use protocol received from plugin
  if (pluginProtocol) {
    return pluginProtocol;
  }

  // Priority 2: Try to get from URL parameters
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const customProtocol = urlParams.get('protocol');
    if (customProtocol === 'https' || customProtocol === 'http') {
      return customProtocol;
    }
  } catch (e) {
    // window.location might not be available
  }

  // Priority 3: Try to get from localStorage
  try {
    const storedProtocol = localStorage.getItem('comfyui_ps_protocol');
    if (storedProtocol === 'https' || storedProtocol === 'http') {
      return storedProtocol;
    }
  } catch (e) {
    // Ignore
  }

  // Priority 4: Fallback to current page protocol, but default to http for WebSocket
  try {
    return window.location.protocol === 'https:' ? 'https' : 'http';
  } catch (e) {
    return 'http'; // Default to http
  }
}

function connect() {
  if (!socket)
    try {
      const { hostname, port } = getServerAddress();
      const protocol = getProtocol();
      // WebSocket always uses ws:// or wss://, not http:// or https://
      const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
      const wsUrl = `${wsProtocol}://${hostname}:${port}/ps/ws?platform=cm&clientId=${clinetid}`;
      console.log(`🔹 Connecting to WebSocket: ${wsUrl}`);
      socket = new WebSocket(wsUrl);

      socket.addEventListener("open", () => {
        console.log("🔹 Connected to the server.");
        sendQueuedMessages();
      });

      socket.addEventListener("message", (event) => {
        try {
          let message = JSON.parse(event.data);
          handleMessage(message);
        } catch (error) {
          console.error("🔹 Error parsing message:", error, event.data);
        }
      });

      socket.addEventListener("close", (event) => {
        console.warn("🔹 Connection closed. Reconnecting...", event);
        socket = null; // Reset socket to allow reconnection
        setTimeout(connect, 5000);
      });

      socket.addEventListener("error", (error) => {
        console.error("🔹 WebSocket error:", error);
        socket.close(); // Close the socket and trigger the reconnect logic
      });
    } catch (error) {
      console.error("🔹 Error establishing WebSocket connection:", error);
      setTimeout(connect, 5000);
    }
}

// Function to generate a unique client ID
function generateClientId() {
  return "cm-" + Math.random().toString(36).substr(2, 9);
}

function handleMessage(message) {
  for (let [type, callback] of Object.entries(listeners)) {
    if (message[type] !== undefined) {
      try {
        callback(message[type]);
      } catch (error) {
        console.error(`🔹 Error handling message of type ${type}:`, error);
      }
    }
  }
}

const messageQueue = [];

function sendQueuedMessages() {
  while (socket && socket.readyState === WebSocket.OPEN && messageQueue.length > 0) {
    const { type, data } = messageQueue.shift();
    socket.send(JSON.stringify({ [type]: data }));
  }
}

const lastSendTimes = {};
let timeoutIds = {};

// Immediately send message without debounce (for important updates like prompt/seed)
async function sendMsgImmediate(type, data) {
  if (!data) data = true;

  // Cancel any pending debounced message of this type
  if (timeoutIds[type]) clearTimeout(timeoutIds[type]);

  try {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ [type]: data }));
      lastSendTimes[type] = Date.now();
      console.log("🔹 Message sent immediately:", type);
    } else {
      console.warn("🔹 WebSocket is not open. Queueing message:", type, data);
      messageQueue.push({ type, data });
    }
  } catch (error) {
    console.error("🔹 Error sending message:", error);
  }
}

// Debounced message send (for frequent updates like progress)
async function sendMsg(type, data, immediate = false) {
  if (!data) data = true;

  // If immediate flag is set, send without debounce
  if (immediate) {
    return sendMsgImmediate(type, data);
  }

  // Cancel previous timeout for this message type
  if (timeoutIds[type]) clearTimeout(timeoutIds[type]);

  // Set new timeout with reduced delay (100ms instead of 500ms)
  timeoutIds[type] = setTimeout(() => {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ [type]: data }));
        lastSendTimes[type] = Date.now();
      } else {
        console.warn("🔹 WebSocket is not open. Queueing message:", type, data);
        messageQueue.push({ type, data });
      }
    } catch (error) {
      console.error("🔹 Error sending message:", error);
    }
  }, 100); // Reduced from 500ms to 100ms for faster response
}

function msg(type, callback) {
  listeners[type] = callback;
}

// Try to extract server address from current URL immediately on load
// This works even if webview cannot display content
(function initServerAddress() {
  try {
    // If window.location is available, extract hostname and port
    if (window.location && window.location.hostname) {
      const hostname = window.location.hostname;
      const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');

      // Only use if it's not localhost (meaning it's a custom IP)
      if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
        pluginServerAddress = { hostname, port };
        pluginProtocol = window.location.protocol === 'https:' ? 'https' : 'http';
        console.log('🔹 Initialized server address from URL:', pluginServerAddress);
      }
    }
  } catch (e) {
    // Ignore errors during initialization
  }
})();

// Export functions for external use
export { connect, sendMsg, sendMsgImmediate, msg, clinetid };
