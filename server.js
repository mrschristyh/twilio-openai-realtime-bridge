import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { parse as parseUrl } from 'url';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

app.get('/', (_req, res) => res.send('OK'));

// Use noServer + manual upgrade to select Twilio's subprotocol
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = parseUrl(req.url || '');
  const protocols = (req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map(s => s.trim());

  // Only accept on /stream and when Twilio offers audio.twilio.com
  if (pathname !== '/stream' || !protocols.includes('audio.twilio.com')) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Tell Twilio we selected the audio.twilio.com subprotocol
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Protocol: audio.twilio.com'
  ];

  // Let ws finish the upgrade
  wss.handleUpgrade(req, socket, head, (ws) => {
    // ws.protocol will be 'audio.twilio.com'
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (twilioWs, req) => {
  console.log('WS connection from Twilio:', req.url);

  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch (e) {
      console.error('Bad JSON from Twilio', e);
      return;
    }

    if (data.event === 'start') {
      console.log('Twilio stream started:', data.start.streamSid);
    }

    if (data.event === 'media') {
      // Echo the incoming μ-law audio back to Twilio (loopback test)
      try {
        twilioWs.send(JSON.stringify({
          event: 'media',
          media: { payload: data.media.payload }
        }));
      } catch (e) {
        console.error('Echo send error:', e);
      }
    }

    if (data.event === 'stop') {
      console.log('Twilio stream stopped.');
    }
  });

  twilioWs.on('error', (err) => console.error('Twilio WS error', err));
  twilioWs.on('close', () => console.log('Twilio WS closed'));
});

server.listen(PORT, () => {
  console.log('Server listening on :' + PORT);
});

