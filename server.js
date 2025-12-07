import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

app.get('/', (_req, res) => res.send('OK'));

const wss = new WebSocketServer({
  server,
  path: '/stream',
  // ✅ Tell Twilio we speak its subprotocol
  handleProtocols: (protocols) => {
    if (protocols && protocols.includes('audio.twilio.com')) return 'audio.twilio.com';
    return false; // reject if not Twilio
  }
});

wss.on('connection', (twilioWs, req) => {
  console.log('WS connection from Twilio:', req.url);

  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch (e) {
      console.error('Bad JSON from Twilio', e);
      return;
    }

    // Twilio sends event types: 'start', 'media', 'stop', 'mark', etc.
    if (data.event === 'start') {
      console.log('Twilio stream started:', data.start.streamSid);
    }

    if (data.event === 'media') {
      // ✅ Echo audio straight back to Twilio so you hear yourself (loopback test)
      // This proves bidirectional audio works without touching OpenAI yet.
      try {
        twilioWs.send(JSON.stringify({
          event: 'media',
          media: {
            // send the SAME base64 mulaw payload back
            payload: data.media.payload
          }
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
