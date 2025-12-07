import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

app.get('/', (_req, res) => res.send('OK'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// We'll do manual upgrade to control subprotocol selection.
const wss = new WebSocketServer({
  noServer: true,
  // This is honored by ws during handleUpgrade and sets Sec-WebSocket-Protocol in the 101 response.
  handleProtocols: (protocols /*, request */) => {
    // Twilio offers "audio.twilio.com" — pick it explicitly.
    if (protocols && protocols.includes('audio.twilio.com')) return 'audio.twilio.com';
    return false; // reject anything else
  }
});

server.on('upgrade', (req, socket, head) => {
  try {
    // Use WHATWG URL to avoid url.parse deprecations
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const protocolsHdr = String(req.headers['sec-websocket-protocol'] || '');
    const protocols = protocolsHdr.split(',').map(s => s.trim()).filter(Boolean);

    console.log('HTTP upgrade attempt:', {
      path: pathname,
      protocolsOffered: protocols
    });

    if (pathname !== '/stream') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!protocols.includes('audio.twilio.com')) {
      // Twilio should always offer this; if not, tell us what it sent.
      console.error('Missing required subprotocol "audio.twilio.com". Offered:', protocols);
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } catch (e) {
    console.error('Upgrade error:', e);
    try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    try { socket.destroy(); } catch {}
  }
});

wss.on('connection', (twilioWs, req) => {
  console.log('WS connection from Twilio:', req.url, 'protocol=', twilioWs.protocol);

  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); }
    catch (e) { console.error('Bad JSON from Twilio', e); return; }

    // Expect events: start, media, mark, stop
    if (data.event === 'start') {
      console.log('Twilio stream started:', data.start?.streamSid);
    }

    if (data.event === 'media') {
      // 🔊 Loopback: echo the same μ-law frame back so you hear yourself (proves WS path)
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
  twilioWs.on('close', (code, reason) => console.log('Twilio WS closed', code, reason?.toString?.()));
});

server.listen(PORT, () => {
  console.log('Server listening on :' + PORT);
});
