const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── In-memory stores ────────────────────────────────────────────────────────
const sseClients = new Map();     // sessionId → response stream
const sessionResults = new Map(); // sessionId → Excel buffer
const runLogs = new Map();        // sessionId → log entries[]

// ─── Utility ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function generateUnique5Digit() {
  const digits = [];
  while (digits.length < 5) {
    const rand = Math.floor(Math.random() * 10);
    if (!digits.includes(rand)) digits.push(rand);
  }
  return digits.join('');
}

function resolveSuffix(suffixTemplate, ba, index = 1, total = 1) {
  const trimmed = (suffixTemplate || '').trim();
  if (!trimmed) {
    return `_T${generateUnique5Digit()}`;
  }
  let resolved = trimmed
    .replace(/\{ba\}/gi, ba)
    .replace(/\{index\}/gi, String(index))
    .replace(/\{total\}/gi, String(total));

  // If the template does not start with '_' or '-', prepend '_'
  if (!resolved.startsWith('_') && !resolved.startsWith('-')) {
    resolved = `_${resolved}`;
  }
  return resolved;
}

function parseCutOffDate(dateStr) {
  // Input: DD/MM/YYYY  →  { DDMMYYYY, YYYYMMDD }
  const parts = dateStr.split('/');
  const dd = String(parts[0]).padStart(2, '0');
  const mm = String(parts[1]).padStart(2, '0');
  const yyyy = String(parts[2]);
  return { DDMMYYYY: `${dd}${mm}${yyyy}`, YYYYMMDD: `${yyyy}${mm}${dd}` };
}

function extractBillGroupCode(billGroup) {
  // "C1 : some description" → "C1"
  return (billGroup || '').split(' :')[0].trim();
}

function addLog(sessionId, level, message, data) {
  const entry = { ts: new Date().toISOString(), level, message, data };
  const logs = runLogs.get(sessionId) || [];
  logs.push(entry);
  runLogs.set(sessionId, logs);
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function sendEvent(sessionId, event) {
  const client = sseClients.get(sessionId);
  if (client) {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  addLog(sessionId, 'event', event.type, event);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// SSE stream endpoint
app.get('/api/stream/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);
  sseClients.set(sessionId, res);

  req.on('close', () => {
    sseClients.delete(sessionId);
  });
});

// Live reload for frontend (Auto-refresh on HTML edit)
const reloadClients = new Set();
app.get('/api/live-reload', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  reloadClients.add(res);
  req.on('close', () => reloadClients.delete(res));
});

let reloadDebounce = null;
const indexPath = path.join(__dirname, 'index.html');
if (fs.existsSync(indexPath)) {
  fs.watch(indexPath, () => {
    clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      console.log('📝 index.html updated — sending reload signal to browser');
      for (const client of reloadClients) {
        client.write('data: reload\n\n');
      }
    }, 150);
  });
}

// Upload & parse Excel
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    const rows = [];
    for (const row of raw) {
      const ba = String(row[0] || '').trim();
      if (!ba || ba.toLowerCase() === 'ba_number' || ba.toLowerCase() === 'ba') continue;
      rows.push({ ba });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'ไม่พบ BA Number ในไฟล์ Excel' });
    }

    const sessionId = uuidv4();
    res.json({ sessionId, rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check for URL02 endpoint
app.post('/api/health-check', async (req, res) => {
  const { url02 } = req.body;
  if (!url02) return res.status(400).json({ ok: false, message: 'ไม่ได้ระบุ URL' });
  const baseUrl = url02.trim().replace(/\/home\/?$/i, '').replace(/\/+$/, '');
  try {
    const startTime = Date.now();
    const response = await axios.get(baseUrl, { timeout: 4000, validateStatus: () => true });
    const latency = Date.now() - startTime;
    return res.json({
      ok: true,
      status: response.status,
      latency: `${latency}ms`,
      message: `เชื่อมต่อสำเร็จ (HTTP ${response.status}) — ${latency}ms`
    });
  } catch (err) {
    return res.json({
      ok: false,
      message: `เชื่อมต่อไปยัง URL ไม่สำเร็จ (${err.code || err.message})`
    });
  }
});

// ─── Billing flow for a single BA ────────────────────────────────────────────

async function runBillingFlow(ba, config, sessionId, index = 1, total = 1) {
  const { url02, createBy, environment, isSimulation } = config;
  // Normalize base URL: ตัด /home หรือ trailing slash ออกอัตโนมัติ
  const baseUrl = (url02 || '')
    .trim()
    .replace(/\/home\/?$/i, '')
    .replace(/\/+$/, '');

  const result = {
    ba,
    billingAccount: '',
    billCycle: '',
    billGroup: '',
    cutOffDate: '',
    processId: '',
    billOrderNumber: '',
    status: 'running',
    error: '',
    stepStatus: {
      checkBillingAccountNew: 'pending',
      GentAcc: 'pending',
      getBIP: 'pending',
      GentProduction: 'pending',
    },
  };

  // ── SIMULATION / CHECK MODE ────────────────────────────────────────────────
  if (isSimulation) {
    try {
      // 1. Mock Check BA
      sendEvent(sessionId, {
        type: 'step_start',
        ba,
        step: 'checkBillingAccountNew',
        message: `[${ba}] (โหมดจำลอง) ตรวจสอบ Billing Account...`,
      });
      await sleep(800);

      result.billingAccount = ba;
      result.billCycle = '01';
      result.billGroup = 'C1';
      result.cutOffDate = '25/09/2026';
      result.stepStatus.checkBillingAccountNew = 'success';

      sendEvent(sessionId, {
        type: 'step_done',
        ba,
        step: 'checkBillingAccountNew',
        status: 'success',
        data: {
          billingAccount: result.billingAccount,
          billCycle: result.billCycle,
          billGroup: result.billGroup,
          cutOffDate: result.cutOffDate,
        },
      });

      // 2. Mock GentAcc
      const suffix = resolveSuffix(config.suffix, ba, index, total);
      const billOrderNumber = `01C120260925${suffix}`;
      const processId = `SIM-${Date.now().toString().slice(-6)}`;

      sendEvent(sessionId, {
        type: 'step_start',
        ba,
        step: 'GentAcc',
        message: `[${ba}] (โหมดจำลอง) Generate Invoice: ${billOrderNumber}`,
      });
      await sleep(800);

      result.processId = processId;
      result.billOrderNumber = billOrderNumber;
      result.stepStatus.GentAcc = 'success';

      sendEvent(sessionId, {
        type: 'step_done',
        ba,
        step: 'GentAcc',
        status: 'success',
        data: { processId, billOrderNumber },
      });

      // 3. Mock getBIP
      sendEvent(sessionId, {
        type: 'step_start',
        ba,
        step: 'getBIP',
        message: `[${ba}] (โหมดจำลอง) รอ 2 วินาที แล้วดึงรายการ BIP...`,
      });
      await sleep(2000);

      result.stepStatus.getBIP = 'success';
      sendEvent(sessionId, {
        type: 'step_done',
        ba,
        step: 'getBIP',
        status: 'success',
        data: { processId: result.processId, billOrderNumber: result.billOrderNumber },
      });

      // 4. Mock GentProduction
      const isProduction = environment === 'Production' || String(environment).toLowerCase().includes('prod');
      const billMode = isProduction ? 'Production' : 'Proforma';

      sendEvent(sessionId, {
        type: 'step_start',
        ba,
        step: 'GentProduction',
        message: `[${ba}] (โหมดจำลอง) ออกบิล [${billMode}]...`,
      });
      await sleep(800);

      result.stepStatus.GentProduction = 'success';
      result.status = 'success';

      sendEvent(sessionId, {
        type: 'step_done',
        ba,
        step: 'GentProduction',
        status: 'success',
        data: { billMode },
      });

      sendEvent(sessionId, { type: 'ba_complete', ba, status: 'success', result });
      return result;
    } catch (err) {
      result.status = 'error';
      result.error = err.message;
      sendEvent(sessionId, { type: 'ba_error', ba, status: 'error', message: err.message, result });
      return result;
    }
  }

  try {
    // ── STEP 1: checkBillingAccountNew ───────────────────────────────────────
    sendEvent(sessionId, {
      type: 'step_start',
      ba,
      step: 'checkBillingAccountNew',
      message: `[${ba}] ตรวจสอบ Billing Account...`,
    });

    const checkRes = await axios.post(
      `${baseUrl}/api/v1/invoicing/checkBillingAccountNew`,
      {
        list_ba_file_data: [ba],
        bill_cycle: '',
        bill_group: '',
        cutoff_date: '',
        confirm: true,
      },
      { timeout: 30000 }
    );

    const checkData = checkRes.data?.result?.[0];
    if (!checkData) throw new Error('checkBillingAccountNew: ไม่พบข้อมูล result[0]');

    result.billingAccount = checkData.billingAccount || ba;
    result.billCycle = checkData.billCycle;
    const billGroupCode = extractBillGroupCode(checkData.billGroup);
    result.billGroup = billGroupCode;
    const cutOff = parseCutOffDate(checkData.cutOffDate);
    result.cutOffDate = checkData.cutOffDate;
    result.stepStatus.checkBillingAccountNew = 'success';

    sendEvent(sessionId, {
      type: 'step_done',
      ba,
      step: 'checkBillingAccountNew',
      status: 'success',
      data: {
        billingAccount: result.billingAccount,
        billCycle: result.billCycle,
        billGroup: billGroupCode,
        cutOffDate: checkData.cutOffDate,
      },
    });

    // ── STEP 2: GentAcc ──────────────────────────────────────────────────────
    const suffix = resolveSuffix(config.suffix, ba, index, total);
    const billOrderNumber = `${result.billCycle}${billGroupCode}${cutOff.YYYYMMDD}${suffix}`;

    sendEvent(sessionId, {
      type: 'step_start',
      ba,
      step: 'GentAcc',
      message: `[${ba}] Generate Invoice: ${billOrderNumber}`,
    });

    const gentAccRes = await axios.post(
      `${baseUrl}/api/v1/invoicing/insertOPSInvoice`,
      {
        task_program: 'GentAcc',
        bill_order_number: billOrderNumber,
        bill_cycle: result.billCycle,
        bill_group: billGroupCode,
        cutoff_date: cutOff.DDMMYYYY,
        hot_bil_rc: '0',
        hot_bil_nrc: '0',
        hot_bil_usage: '0',
        create_by: createBy,
        confirm: false,
        list_ba_file_data: [result.billingAccount],
      },
      { timeout: 60000 }
    );

    const processId = gentAccRes.data?.result?.processId;
    if (!processId) throw new Error('GentAcc: ไม่พบ processId ใน response');

    result.processId = processId;
    result.stepStatus.GentAcc = 'success';

    sendEvent(sessionId, {
      type: 'step_done',
      ba,
      step: 'GentAcc',
      status: 'success',
      data: { processId: result.processId, billOrderNumber },
    });

    // ── STEP 3: getBIP (delay 5s) ────────────────────────────────────────────
    sendEvent(sessionId, {
      type: 'step_start',
      ba,
      step: 'getBIP',
      message: `[${ba}] รอ 5 วินาที แล้วดึงรายการ BIP...`,
    });

    await sleep(5000);

    const bipRes = await axios.post(
      `${baseUrl}/api/v1/gentBIP/getBIP`,
      {
        createBy: createBy,
        firstLoadPage: 'F',
        pagination: { current: 1, pageSize: 5 },
        sorter: {},
      },
      { timeout: 30000 }
    );

    const bipData = bipRes.data?.result?.[0];
    if (!bipData) throw new Error('getBIP: ไม่พบ result[0]');

    result.processId = bipData.processId || result.processId;
    result.billOrderNumber = bipData.billOrderNumber || billOrderNumber;
    result.stepStatus.getBIP = 'success';

    sendEvent(sessionId, {
      type: 'step_done',
      ba,
      step: 'getBIP',
      status: 'success',
      data: {
        processId: result.processId,
        billOrderNumber: result.billOrderNumber,
      },
    });

    // ── STEP 4: Gent Production / Proforma ───────────────────────────────────
    const isProduction = environment === 'Production' || String(environment).toLowerCase().includes('prod');
    const billMode = isProduction ? 'Production' : 'Proforma';
    const prodUrl = `${baseUrl}/api/v1/invoicing/insertOPSInvoice`;

    sendEvent(sessionId, {
      type: 'step_start',
      ba,
      step: 'GentProduction',
      message: `[${ba}] ออกบิล [${billMode}]...`,
    });

    await axios.post(
      prodUrl,
      {
        process_id: result.processId,
        bill_order_number: result.billOrderNumber,
        task_program: 'BIP',
        bill_mode: billMode,
        bill_cycle: result.billCycle,
        create_by: createBy,
        cutoff_date: cutOff.DDMMYYYY,
      },
      { timeout: 60000 }
    );

    result.stepStatus.GentProduction = 'success';
    result.status = 'success';

    sendEvent(sessionId, {
      type: 'step_done',
      ba,
      step: 'GentProduction',
      status: 'success',
      data: { billMode },
    });

    sendEvent(sessionId, { type: 'ba_complete', ba, status: 'success', result });
  } catch (err) {
    const stepFailed = Object.keys(result.stepStatus).find(
      (s) => result.stepStatus[s] === 'pending'
    );
    if (stepFailed) result.stepStatus[stepFailed] = 'error';
    result.status = 'error';
    result.error =
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message ||
      'Unknown error';

    sendEvent(sessionId, {
      type: 'ba_error',
      ba,
      status: 'error',
      step: stepFailed,
      message: result.error,
      result,
    });
  }

  return result;
}

// ─── Run automation ───────────────────────────────────────────────────────────

app.post('/api/run', async (req, res) => {
  const { sessionId, bas, config } = req.body;

  if (!sessionId || !bas || !config) {
    return res.status(400).json({ error: 'Missing sessionId, bas, or config' });
  }

  // Respond immediately so client isn't waiting
  res.json({ started: true, count: bas.length });

  // Run in background
  (async () => {
    const results = [];
    let idx = 0;

    sendEvent(sessionId, {
      type: 'run_start',
      total: bas.length,
      message: `เริ่มรัน ${bas.length} BA(s)...`,
    });

    for (const { ba } of bas) {
      idx++;
      sendEvent(sessionId, {
        type: 'ba_start',
        ba,
        index: idx,
        total: bas.length,
      });

      const result = await runBillingFlow(ba, config, sessionId, idx, bas.length);
      results.push(result);
    }

    // Build result Excel
    const wb = xlsx.utils.book_new();
    const wsData = [
      ['BA', 'Billing Account', 'Bill Cycle', 'Bill Group', 'Cut Off Date', 'Process ID', 'Bill Order Number', 'Status', 'Error'],
    ];

    for (const r of results) {
      wsData.push([
        r.ba,
        r.billingAccount,
        r.billCycle,
        r.billGroup,
        r.cutOffDate,
        r.processId,
        r.billOrderNumber,
        r.status === 'success' ? 'Success ✅' : 'Failed ❌',
        r.error || '',
      ]);
    }

    const ws = xlsx.utils.aoa_to_sheet(wsData);
    // Set column widths
    ws['!cols'] = [
      { wch: 15 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
      { wch: 20 }, { wch: 30 }, { wch: 12 }, { wch: 40 },
    ];
    xlsx.utils.book_append_sheet(wb, ws, 'Results');

    // Log sheet
    const logsSheet = xlsx.utils.json_to_sheet(runLogs.get(sessionId) || []);
    xlsx.utils.book_append_sheet(wb, logsSheet, 'Logs');

    const reportDir = path.join(__dirname, 'Data', 'Report');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }
    const filename = `billing_results_${Date.now()}.xlsx`;
    const fullPath = path.join(reportDir, filename);

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    fs.writeFileSync(fullPath, buffer);
    sessionResults.set(sessionId, { buffer, filename, fullPath });

    const successCount = results.filter((r) => r.status === 'success').length;
    sendEvent(sessionId, {
      type: 'all_done',
      total: bas.length,
      success: successCount,
      failed: bas.length - successCount,
      downloadId: sessionId,
      filename: filename,
      savedPath: fullPath,
    });
  })();
});

// ─── Download result Excel & Save to Report Folder ────────────────────────────

app.get('/api/download/:sessionId', (req, res) => {
  const item = sessionResults.get(req.params.sessionId);
  if (!item) return res.status(404).json({ error: 'Result not found' });

  const buffer = item.buffer || item;
  const filename = item.filename || `billing_results_${Date.now()}.xlsx`;
  const reportDir = path.join(__dirname, 'Data', 'Report');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  const fullPath = item.fullPath || path.join(reportDir, filename);
  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, buffer);
  }

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"`
  );
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.send(buffer);
});

// ─── Open Report Folder ───────────────────────────────────────────────────────

app.post('/api/open-report-folder', (req, res) => {
  const reportDir = path.join(__dirname, 'Data', 'Report');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  exec(`explorer.exe "${reportDir}"`);
  res.json({ ok: true, path: reportDir });
});

// ─── Download Log ─────────────────────────────────────────────────────────────

app.get('/api/logs/:sessionId', (req, res) => {
  const logs = runLogs.get(req.params.sessionId) || [];
  res.json(logs);
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║     OPS Billing Auto — Server Started    ║');
  console.log(`║     http://localhost:${PORT}                ║`);
  console.log('╚══════════════════════════════════════════╝\n');
});
