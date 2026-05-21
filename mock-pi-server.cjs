/**
 * Mock Pi Remote-Control WebSocket Server
 */
const { WebSocketServer } = require('ws');

const PORT = 8765;
const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });

console.log(`Mock Pi server listening on ws://0.0.0.0:${PORT}`);
console.log('From emulator, connect to: ws://10.0.2.2:8765');

const MOCK_SESSION = {
  id: 'mock-self',
  name: 'Mock-Pi',
  kind: 'self',
  status: 'idle',
  connectedAt: Date.now(),
  lastActivity: Date.now(),
  messageCount: 0,
  turnIndex: 0,
};

const MOCK_COMMANDS = [
  { name: 'remote-control', description: 'Start remote control server' },
  { name: 'remote-stop', description: 'Stop remote control server' },
];

function sendSessionList(ws) {
  MOCK_SESSION.lastActivity = Date.now();
  ws.send(JSON.stringify({ type: 'session_list', sessions: [MOCK_SESSION] }));
}

function sendCommandList(ws) {
  ws.send(JSON.stringify({ type: 'command_list', commands: MOCK_COMMANDS }));
}

wss.on('connection', (ws) => {
  console.log('[+] Client connected');

  ws.send(JSON.stringify({ type: 'connected', clients: wss.clients.size }));
  sendSessionList(ws);
  sendCommandList(ws);

  ws.on('message', (data) => {
    try {
      const cmd = JSON.parse(data.toString());
      console.log('Received:', JSON.stringify(cmd));

      switch (cmd.type) {
        case 'prompt':
          handlePrompt(ws, cmd.message);
          break;
        case 'steer':
          handleSteer(ws, cmd.message);
          break;
        case 'follow_up':
          handleFollowUp(ws, cmd.message);
          break;
        case 'get_sessions':
          sendSessionList(ws);
          break;
        case 'get_commands':
          sendCommandList(ws);
          break;
        case 'get_state':
          ws.send(JSON.stringify({
            type: 'response',
            command: 'get_state',
            success: true,
            data: { clients: wss.clients.size, connected: true }
          }));
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', error: `Unknown type: ${cmd.type}` }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: 'Bad JSON' }));
    }
  });

  ws.on('close', () => console.log('[-] Client disconnected'));
});

function handlePrompt(ws, message) {
  console.log(`Processing prompt: "${message}"`);
  doAgentFlow(ws, message, 'prompt');
}

function handleSteer(ws, message) {
  console.log(`Processing steer: "${message}"`);
  ws.send(JSON.stringify({
    type: 'message_start',
    message: { role: 'user', content: message }
  }));
  // Steer just acknowledges and lets the agent continue
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'message_start',
      message: { role: 'assistant', content: '' }
    }));
    ws.send(JSON.stringify({ type: 'message_update', eventType: 'text_start' }));
    const r = 'Steer received: I adjusted my approach based on: ' + message;
    let i = 0;
    const iv = setInterval(() => {
      const c = r.slice(i, i+3);
      if (c) { ws.send(JSON.stringify({type:'message_update',eventType:'text_delta',delta:c})); i+=3;
      } else { clearInterval(iv);
        ws.send(JSON.stringify({type:'message_update',eventType:'text_end'}));
        ws.send(JSON.stringify({type:'message_end',message:{role:'assistant',content:r}}));
        ws.send(JSON.stringify({type:'agent_end',messageCount:3}));
      }
    }, 40);
  }, 500);
}

function handleFollowUp(ws, message) {
  console.log(`Processing follow_up: "${message}"`);
  doAgentFlow(ws, message, 'follow_up');
}

function doAgentFlow(ws, message, cmdType) {
  // Echo user message
  ws.send(JSON.stringify({
    type: 'message_start',
    message: { role: 'user', content: message }
  }));
  
  // Simulate agent working
  ws.send(JSON.stringify({ type: 'agent_start' }));
  ws.send(JSON.stringify({ type: 'turn_start', turnIndex: 1 }));
  
  // Simulate thinking
  ws.send(JSON.stringify({ type: 'message_update', eventType: 'thinking_start' }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'message_update', eventType: 'thinking_delta', delta: 'Analyzing request...' }));
  }, 300);
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'message_update', eventType: 'thinking_end' }));
  }, 800);
  
  // Simulate assistant response with streaming
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'message_start',
      message: { role: 'assistant', content: '' }
    }));
    ws.send(JSON.stringify({ type: 'message_update', eventType: 'text_start' }));
    
    const response = 'I received your ' + cmdType + ': ' + message + '. Mock response from Pi Remote Control server. The Android app is working!';
    
    let idx = 0;
    const deltaInterval = setInterval(() => {
      const chunk = response.slice(idx, idx + 3);
      if (chunk) {
        ws.send(JSON.stringify({ type: 'message_update', eventType: 'text_delta', delta: chunk }));
        idx += 3;
      } else {
        clearInterval(deltaInterval);
        ws.send(JSON.stringify({ type: 'message_update', eventType: 'text_end' }));
        ws.send(JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: response }
        }));
        // Simulate code tool execution showing Kotlin code
        setTimeout(() => {
          const codeContent = `fun greet(name: String): String {
    // Say hello to the user
    val greeting: String = "Hello, " + name
    val count: Int = 3
    return greeting
}`;
          ws.send(JSON.stringify({ type: 'tool_start', toolName: 'edit', toolCallId: 'call-0' }));
          setTimeout(() => {
            const fullCode = `Successfully edited: file:///home/grunt/pi-remote-control/src/main/kotlin/Greeting.kt\n${codeContent}`;
            ws.send(JSON.stringify({ type: 'tool_end', toolName: 'edit', toolCallId: 'call-0', content: fullCode }));
            ws.send(JSON.stringify({ type: 'message_start', message: { role: 'toolResult', toolCallId: 'call-0', toolName: 'edit', content: fullCode } }));
            ws.send(JSON.stringify({ type: 'turn_end', turnIndex: 1 }));
            ws.send(JSON.stringify({ type: 'agent_end', messageCount: 3 }));
          }, 500);
        }, 1500);
      }
    }, 30);
  }, 1200);
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close();
  process.exit(0);
});
