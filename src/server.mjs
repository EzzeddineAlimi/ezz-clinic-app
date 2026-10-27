import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Clinic } from './clinic.ts';

const app = new Clinic();
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');
const demo = app.addPatient('DEMO PATIENT (FICTIONAL)', '00000000');
app.addAppointment(demo.id, '2026-10-28T09:00');
const actions = {
  patient: (v) => app.addPatient(v.name, v.phone || ''),
  appointment: (v) => app.addAppointment(v.patientId, v.startsAt),
  care: (v) => app.confirmCare(v.appointmentId, v.treatment, v.feeMillimes),
  payment: (v) => app.pay(v.appointmentId, v.amountMillimes, v.method),
  count: (v) => app.countCash(v.countedMillimes),
};
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(type === 'application/json' ? JSON.stringify(body):body);
}
async function body(req) {
  let raw = '';
  for await (const part of req) {
    raw += part.toString();
    if (raw.length > 10000) throw new Error('Payload too large');
  }
  return JSON.parse(raw);
}
createServer(async (req,res) => {
  try {
    if (req.method === 'GET' && req.url === '/') return send(res,200,await readFile(join(publicDir,'index.html'),'utf8'),'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/api/state') return send(res,200,app.snapshot());
    if (req.method === 'POST' && req.url?.startsWith('/api/')) {
      const action = req.url.slice('/api/'.length);
      if (!Object.hasOwn(actions, action)) return send(res,404,{error:'Unknown action'});
      const payload = await body(req);
      return send(res,200,{result:actions[action](payload),state:app.snapshot()});
    }
    return send(res,404,{error:'Not found'});
  } catch (error) { return send(res,400,{error:error.message}); }
}).listen(4173,'127.0.0.1',() => console.log('FICTIONAL DEMO ONLY: http://127.0.0.1:4173'));
