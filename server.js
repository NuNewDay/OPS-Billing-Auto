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
const activeRuns = new Set();     // sessionId set of running jobs

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
    try {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (e) {
      console.error(`[SSE Write Error] Session ${sessionId}:`, e.message);
      sseClients.delete(sessionId);
    }
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

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      clearInterval(keepAlive);
    }
  }, 10000);

  req.on('close', () => {
    clearInterval(keepAlive);
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

// ─── Billing flow for a single BA (1 BA = 1 Bill Order) ───────────────────────

async function runIndividualBillingFlow(ba, config, sessionId, index = 1, total = 1) {
  const { url02, createBy, uuid, environment, isSimulation } = config;
  const creatorUuid = (uuid || '').trim() || 'f6c369a9-2197-45e5-a0b1-26aaba878703';
  const creatorName = (createBy || '').trim() || 'นาย ทดสอบ SSO';

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
    proformaSeq: null,
    status: 'running',
    error: '',
    stepStatus: {
      checkBillingAccountNew: 'pending',
      GentAcc: 'pending',
      getBIP: 'pending',
      GentProforma: 'pending',
      GentProduction: 'pending',
    },
  };

  // ── SIMULATION MODE ────────────────────────────────────────────────────────
  if (isSimulation) {
    try {
      sendEvent(sessionId, {
        type: 'step_start',
        ba,
        step: 'checkBillingAccountNew',
        message: `[${ba}] (โหมดจำลอง) ตรวจสอบ Billing Account...`,
      });
      await sleep(600);

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

      const suffix = resolveSuffix(config.suffix, ba, index, total);
      const billOrderNumber = `01C120260925${suffix}`;
      const processId = `SIM-${Date.now().toString().slice(-6)}`;

      sendEvent(sessionId, {
        type: 'step_start',
        ba,
        step: 'GentAcc',
        message: `[${ba}] (โหมดจำลอง) Generate Invoice: ${billOrderNumber}`,
      });
      await sleep(600);

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

      sendEvent(sessionId, {
        type: 'step_start',
        ba,
        step: 'getBIP',
        message: `[${ba}] (โหมดจำลอง) ตรวจสอบสถานะ BIP (Process ID: ${processId})...`,
      });
      await sleep(800);

      result.stepStatus.getBIP = 'success';
      sendEvent(sessionId, {
        type: 'step_done',
        ba,
        step: 'getBIP',
        status: 'success',
        data: { processId, billOrderNumber },
      });

      const billMode = (config.billMode && config.billMode.trim()) || 'Auto';
      const shouldRunProforma = billMode === 'Auto' || billMode.toLowerCase() === 'proforma';
      const shouldRunProduction = billMode === 'Auto' || billMode.toLowerCase() === 'production';

      if (shouldRunProforma) {
        sendEvent(sessionId, {
          type: 'step_start',
          ba,
          step: 'GentProforma',
          message: `[${ba}] (โหมดจำลอง) ออกบิลร่าง Proforma...`,
        });
        await sleep(600);
        result.proformaSeq = 1;
        result.stepStatus.GentProforma = 'success';
        sendEvent(sessionId, {
          type: 'step_done',
          ba,
          step: 'GentProforma',
          status: 'success',
          data: { proformaSeq: 1, processId, billOrderNumber },
        });
      }

      if (shouldRunProduction) {
        sendEvent(sessionId, {
          type: 'step_start',
          ba,
          step: 'GentProduction',
          message: `[${ba}] (โหมดจำลอง) ยืนยันออกบิล Production...`,
        });
        await sleep(600);
        result.stepStatus.GentProduction = 'success';
        sendEvent(sessionId, {
          type: 'step_done',
          ba,
          step: 'GentProduction',
          status: 'success',
          data: { billMode: 'Production', processId, billOrderNumber },
        });
      }

      result.status = 'success';
      sendEvent(sessionId, {
        type: 'ba_complete',
        ba,
        status: 'success',
        result,
      });

      return result;
    } catch (err) {
      result.status = 'error';
      result.error = err.message;
      sendEvent(sessionId, {
        type: 'ba_error',
        ba,
        status: 'error',
        message: err.message,
        result,
      });
      return result;
    }
  }

  // ── REAL MODE (1 BA = 1 บิล) ─────────────────────────────────────────────
  try {
    if (!activeRuns.has(sessionId)) {
      throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
    }

    // ── STEP 1: checkBillingAccountNew
    sendEvent(sessionId, {
      type: 'step_start',
      ba,
      step: 'checkBillingAccountNew',
      message: `[${ba}] ตรวจสอบข้อมูล Billing Account กับระบบ OPS...`,
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
    if (!checkData || checkRes.data?.result === 'notFound Data') {
      throw new Error(`[${ba}] ไม่พบข้อมูลในระบบ OPS สำหรับรอบบิลนี้ (notFound Data)`);
    }

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

    if (!activeRuns.has(sessionId)) {
      throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
    }

    // ── STEP 2: GentAcc
    const suffix = resolveSuffix(config.suffix, ba, index, total);
    const billOrderNumber = `${result.billCycle}${billGroupCode}${cutOff.YYYYMMDD}${suffix}`;

    sendEvent(sessionId, {
      type: 'step_start',
      ba,
      step: 'GentAcc',
      message: `[${ba}] สร้างใบแจ้งหนี้ (${billOrderNumber})...`,
    });

    const gentAccPayload = {
      task_program: 'GentAcc',
      bill_order_number: billOrderNumber,
      bill_cycle: result.billCycle,
      bill_group: billGroupCode,
      cutoff_date: cutOff.DDMMYYYY,
      hot_bil_rc: '0',
      hot_bil_nrc: '0',
      hot_bil_usage: '0',
      create_by: creatorUuid,
      confirm: false,
      list_ba_file_data: [result.billingAccount],
    };

    let gentAccRes = await axios.post(
      `${baseUrl}/api/v1/invoicing/insertOPSInvoice`,
      gentAccPayload,
      { timeout: 30000 }
    );

    // Auto-confirm if GentAcc Duplicate (same logic as OPS SIT web frontend)
    if (
      gentAccRes.data?.result?.status === 'warning' &&
      gentAccRes.data?.result?.message === 'GentAcc Duplicate'
    ) {
      sendEvent(sessionId, {
        type: 'step_start',
        ba,
        step: 'GentAcc',
        message: `[${ba}] พบข้อมูล GentAcc Duplicate — ยืนยันออกบิลซ้ำอัตโนมัติ (confirm: true)...`,
      });
      gentAccPayload.confirm = true;
      gentAccRes = await axios.post(
        `${baseUrl}/api/v1/invoicing/insertOPSInvoice`,
        gentAccPayload,
        { timeout: 30000 }
      );
    }

    if (gentAccRes.data?.result === 'notFound Data' || typeof gentAccRes.data?.result === 'string') {
      throw new Error(`[${ba}] GentAcc: ${gentAccRes.data.result || 'ไม่พบข้อมูลในระบบ OPS (notFound Data)'}`);
    }

    const processId = gentAccRes.data?.result?.processId;
    if (!processId) {
      const errMsg = gentAccRes.data?.result?.message || gentAccRes.data?.message || 'ไม่พบ processId ใน response';
      throw new Error(`[${ba}] GentAcc: ${errMsg}`);
    }

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

    if (!activeRuns.has(sessionId)) {
      throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
    }

    // ── STEP 3: getBIP — รอจนกว่าสถานะ GentAcc ใน OPS จะเป็น Finish
    sendEvent(sessionId, {
      type: 'step_start',
      ba,
      step: 'getBIP',
      message: `[${ba}] รอระบบ OPS ประมวลผล GentAcc ให้เสร็จสิ้น (Process ID: ${processId})...`,
    });

    for (let attempt = 1; attempt <= 10; attempt++) {
      if (!activeRuns.has(sessionId)) {
        throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
      }
      await sleep(1500);

      try {
        const bipRes = await axios.post(
          `${baseUrl}/api/v1/gentBIP/getBIP`,
          {
            firstLoadPage: 'F',
            pagination: { current: 1, pageSize: 25 },
            sorter: {},
          },
          { timeout: 15000 }
        );

        const items = bipRes.data?.result || [];
        const matched = Array.isArray(items)
          ? items.find(
              (item) =>
                String(item.processId) === String(processId) ||
                String(item.billOrderNumber) === String(billOrderNumber)
            )
          : null;

        if (matched) {
          result.processId = matched.processId || processId;
          result.billOrderNumber = matched.billOrderNumber || billOrderNumber;
          if (matched.status === 'Finish' || (matched.status && !matched.status.includes('progress'))) {
            break;
          }
        }
      } catch (bipErr) {
        console.warn(`[${ba}] [getBIP Warning attempt ${attempt}] ${bipErr.message}. Continuing with processId ${processId}`);
      }
    }

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

    if (!activeRuns.has(sessionId)) {
      throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
    }

    // ── STEP 4 & 5: GentProforma and/or GentProduction
    const modeSetting = (config.billMode && config.billMode.trim()) || 'Auto';
    const shouldRunProforma = modeSetting === 'Auto' || modeSetting.toLowerCase() === 'proforma';
    const shouldRunProduction = modeSetting === 'Auto' || modeSetting.toLowerCase() === 'production';
    const prodUrl = `${baseUrl}/api/v1/invoicing/insertOPSInvoice`;

    if (shouldRunProforma) {
      if (!activeRuns.has(sessionId)) {
        throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
      }

      sendEvent(sessionId, {
        type: 'step_start',
        ba,
        step: 'GentProforma',
        message: `[${ba}] กำลังออกบิลร่าง Proforma (Process ID: ${result.processId})...`,
      });

      try {
        const pfRes = await axios.post(
          prodUrl,
          {
            process_id: result.processId,
            bill_order_number: result.billOrderNumber,
            task_program: 'BIP',
            bill_mode: 'Proforma',
            bill_cycle: result.billCycle,
            create_by: creatorUuid,
            cutoff_date: cutOff.DDMMYYYY,
          },
          { timeout: 30000 }
        );

        const pfSeq = pfRes.data?.result?.proformaSeq;
        if (pfSeq != null) result.proformaSeq = pfSeq;

        if (shouldRunProduction) {
          // รอให้สถานะ Proforma ใน OPS ประมวลผลเสร็จ (Finish) ก่อนปิดสเต็ป Proforma
          for (let pfWait = 1; pfWait <= 8; pfWait++) {
            if (!activeRuns.has(sessionId)) {
              throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
            }
            await sleep(1500);
            try {
              const bipRes = await axios.post(
                `${baseUrl}/api/v1/gentBIP/getBIP`,
                { firstLoadPage: 'F', pagination: { current: 1, pageSize: 25 }, sorter: {} },
                { timeout: 15000 }
              );
              const items = bipRes.data?.result || [];
              const matched = items.find(
                (item) => String(item.processId) === String(result.processId)
              );
              if (matched && matched.status === 'Finish' && matched.billMode === 'Proforma') {
                break;
              }
            } catch (e) {}
          }
        }

        result.stepStatus.GentProforma = 'success';

        sendEvent(sessionId, {
          type: 'step_done',
          ba,
          step: 'GentProforma',
          status: 'success',
          data: { proformaSeq: pfSeq || 1, processId: result.processId, billOrderNumber: result.billOrderNumber },
        });
      } catch (pfErr) {
        const errMsg = pfErr.response?.data?.message || pfErr.message || 'Proforma Failed';
        console.warn(`[${ba}] [GentProforma Error] ${errMsg}`);
        result.stepStatus.GentProforma = 'error';
        sendEvent(sessionId, {
          type: 'step_done',
          ba,
          step: 'GentProforma',
          status: 'error',
          message: errMsg,
        });
        throw new Error(`[${ba}] GentProforma: ${errMsg}`);
      }
    }

    if (shouldRunProduction) {
      if (!activeRuns.has(sessionId)) {
        throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
      }

      sendEvent(sessionId, {
        type: 'step_start',
        ba,
        step: 'GentProduction',
        message: `[${ba}] ยืนยันออกบิล Production (Process ID: ${result.processId})...`,
      });

      await axios.post(
        prodUrl,
        {
          process_id: result.processId,
          bill_order_number: result.billOrderNumber,
          task_program: 'BIP',
          bill_mode: 'Production',
          bill_cycle: result.billCycle,
          create_by: creatorUuid,
          cutoff_date: cutOff.DDMMYYYY,
        },
        { timeout: 30000 }
      );

      result.stepStatus.GentProduction = 'success';

      sendEvent(sessionId, {
        type: 'step_done',
        ba,
        step: 'GentProduction',
        status: 'success',
        data: { billMode: 'Production', processId: result.processId, billOrderNumber: result.billOrderNumber },
      });
    }

    result.status = 'success';

    sendEvent(sessionId, {
      type: 'ba_complete',
      ba,
      status: 'success',
      result,
    });
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

// ─── Billing flow for a file (1 File = 1 Bill Order) ──────────────────────────

async function runBatchBillingFlow(baList, config, sessionId) {
  const { url02, createBy, uuid, environment, isSimulation } = config;
  const creatorUuid = (uuid || '').trim() || 'f6c369a9-2197-45e5-a0b1-26aaba878703';
  const creatorName = (createBy || '').trim() || 'นาย ทดสอบ SSO';

  // Normalize base URL: ตัด /home หรือ trailing slash ออกอัตโนมัติ
  const baseUrl = (url02 || '')
    .trim()
    .replace(/\/home\/?$/i, '')
    .replace(/\/+$/, '');

  const count = baList.length;

  const batchResult = {
    baList,
    count,
    billCycle: '',
    billGroup: '',
    cutOffDate: '',
    processId: '',
    billOrderNumber: '',
    proformaSeq: null,
    status: 'running',
    error: '',
    stepStatus: {
      checkBillingAccountNew: 'pending',
      GentAcc: 'pending',
      getBIP: 'pending',
      GentProforma: 'pending',
      GentProduction: 'pending',
    },
    items: [], // individual rows for Excel export
  };

  // ── SIMULATION MODE ────────────────────────────────────────────────────────
  if (isSimulation) {
    try {
      sendEvent(sessionId, {
        type: 'step_start',
        step: 'checkBillingAccountNew',
        message: `(โหมดจำลอง) ตรวจสอบข้อมูล ${count} BA ในไฟล์...`,
      });
      await sleep(800);

      batchResult.billCycle = '01';
      batchResult.billGroup = 'C1';
      batchResult.cutOffDate = '25/09/2026';
      batchResult.stepStatus.checkBillingAccountNew = 'success';

      sendEvent(sessionId, {
        type: 'step_done',
        step: 'checkBillingAccountNew',
        status: 'success',
        data: {
          totalBAs: count,
          billCycle: batchResult.billCycle,
          billGroup: batchResult.billGroup,
          cutOffDate: batchResult.cutOffDate,
        },
      });

      const suffix = resolveSuffix(config.suffix, baList[0], 1, 1);
      const billOrderNumber = `01C120260925${suffix}`;
      const processId = `SIM-${Date.now().toString().slice(-6)}`;
      batchResult.billOrderNumber = billOrderNumber;
      batchResult.processId = processId;

      sendEvent(sessionId, {
        type: 'step_start',
        step: 'GentAcc',
        message: `(โหมดจำลอง) สร้าง 1 บิล [${billOrderNumber}] สำหรับ ${count} BA...`,
      });
      await sleep(800);
      batchResult.stepStatus.GentAcc = 'success';

      sendEvent(sessionId, {
        type: 'step_done',
        step: 'GentAcc',
        status: 'success',
        data: { processId, billOrderNumber, totalBAs: count },
      });

      sendEvent(sessionId, {
        type: 'step_start',
        step: 'getBIP',
        message: `(โหมดจำลอง) รอ 2 วินาที แล้วตรวจสอบสถานะงาน BIP (Process ID: ${processId})...`,
      });
      await sleep(1200);
      batchResult.stepStatus.getBIP = 'success';

      sendEvent(sessionId, {
        type: 'step_done',
        step: 'getBIP',
        status: 'success',
        data: { processId, billOrderNumber },
      });

      const billMode = (config.billMode && config.billMode.trim()) || 'Auto';
      const shouldRunProforma = billMode === 'Auto' || billMode.toLowerCase() === 'proforma';
      const shouldRunProduction = billMode === 'Auto' || billMode.toLowerCase() === 'production';

      if (shouldRunProforma) {
        sendEvent(sessionId, {
          type: 'step_start',
          step: 'GentProforma',
          message: `(โหมดจำลอง) ออกบิลร่าง Proforma สำหรับ ${count} BA...`,
        });
        await sleep(600);
        batchResult.proformaSeq = 1;
        batchResult.stepStatus.GentProforma = 'success';
        sendEvent(sessionId, {
          type: 'step_done',
          step: 'GentProforma',
          status: 'success',
          data: { proformaSeq: 1, processId, billOrderNumber },
        });
      }

      if (shouldRunProduction) {
        sendEvent(sessionId, {
          type: 'step_start',
          step: 'GentProduction',
          message: `(โหมดจำลอง) ยืนยันออกบิล Production สำหรับ ${count} BA...`,
        });
        await sleep(600);
        batchResult.stepStatus.GentProduction = 'success';
        sendEvent(sessionId, {
          type: 'step_done',
          step: 'GentProduction',
          status: 'success',
          data: { billMode: 'Production', processId, billOrderNumber },
        });
      }

      batchResult.status = 'success';

      for (const ba of baList) {
        batchResult.items.push({
          ba,
          billingAccount: ba,
          billCycle: batchResult.billCycle,
          billGroup: batchResult.billGroup,
          cutOffDate: batchResult.cutOffDate,
          processId: batchResult.processId,
          billOrderNumber: batchResult.billOrderNumber,
          proformaSeq: batchResult.proformaSeq,
          status: 'success',
          error: '',
        });
      }

      sendEvent(sessionId, { type: 'batch_complete', status: 'success', result: batchResult });
      return batchResult;
    } catch (err) {
      batchResult.status = 'error';
      batchResult.error = err.message;
      sendEvent(sessionId, { type: 'batch_error', status: 'error', message: err.message, result: batchResult });
      return batchResult;
    }
  }

  // ── REAL MODE (1 ไฟล์ = 1 บิล) ─────────────────────────────────────────────
  try {
    if (!activeRuns.has(sessionId)) {
      throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
    }

    // ── STEP 1: checkBillingAccountNew (All BAs in file)
    sendEvent(sessionId, {
      type: 'step_start',
      step: 'checkBillingAccountNew',
      message: `ตรวจสอบข้อมูล ${count} BA กับระบบ OPS...`,
    });

    const checkRes = await axios.post(
      `${baseUrl}/api/v1/invoicing/checkBillingAccountNew`,
      {
        list_ba_file_data: baList,
        bill_cycle: '',
        bill_group: '',
        cutoff_date: '',
        confirm: true,
      },
      { timeout: 30000 }
    );

    const checkData = checkRes.data?.result?.[0];
    if (!checkData || checkRes.data?.result === 'notFound Data') {
      throw new Error('checkBillingAccountNew: ไม่พบข้อมูล BA ในระบบ OPS (notFound Data)');
    }

    batchResult.billCycle = checkData.billCycle;
    const billGroupCode = extractBillGroupCode(checkData.billGroup);
    batchResult.billGroup = billGroupCode;
    const cutOff = parseCutOffDate(checkData.cutOffDate);
    batchResult.cutOffDate = checkData.cutOffDate;
    batchResult.stepStatus.checkBillingAccountNew = 'success';

    sendEvent(sessionId, {
      type: 'step_done',
      step: 'checkBillingAccountNew',
      status: 'success',
      data: {
        totalBAs: count,
        billCycle: batchResult.billCycle,
        billGroup: billGroupCode,
        cutOffDate: checkData.cutOffDate,
      },
    });

    if (!activeRuns.has(sessionId)) {
      throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
    }

    // ── STEP 2: GentAcc (1 Bill Order for ALL BAs)
    const suffix = resolveSuffix(config.suffix, baList[0], 1, 1);
    const billOrderNumber = `${batchResult.billCycle}${billGroupCode}${cutOff.YYYYMMDD}${suffix}`;

    sendEvent(sessionId, {
      type: 'step_start',
      step: 'GentAcc',
      message: `สร้างใบแจ้งหนี้ 1 บิล (${billOrderNumber}) สำหรับ ${count} BA...`,
    });

    const gentAccPayload = {
      task_program: 'GentAcc',
      bill_order_number: billOrderNumber,
      bill_cycle: batchResult.billCycle,
      bill_group: billGroupCode,
      cutoff_date: cutOff.DDMMYYYY,
      hot_bil_rc: '0',
      hot_bil_nrc: '0',
      hot_bil_usage: '0',
      create_by: creatorUuid,
      confirm: false,
      list_ba_file_data: baList,
    };

    let gentAccRes = await axios.post(
      `${baseUrl}/api/v1/invoicing/insertOPSInvoice`,
      gentAccPayload,
      { timeout: 30000 }
    );

    // Auto-confirm if GentAcc Duplicate
    if (
      gentAccRes.data?.result?.status === 'warning' &&
      gentAccRes.data?.result?.message === 'GentAcc Duplicate'
    ) {
      sendEvent(sessionId, {
        type: 'step_start',
        step: 'GentAcc',
        message: `พบข้อมูล GentAcc Duplicate — ยืนยันออกบิลซ้ำอัตโนมัติ (confirm: true)...`,
      });
      gentAccPayload.confirm = true;
      gentAccRes = await axios.post(
        `${baseUrl}/api/v1/invoicing/insertOPSInvoice`,
        gentAccPayload,
        { timeout: 30000 }
      );
    }

    if (gentAccRes.data?.result === 'notFound Data' || typeof gentAccRes.data?.result === 'string') {
      throw new Error(gentAccRes.data.result || 'GentAcc: ไม่พบข้อมูลในระบบ OPS (notFound Data)');
    }

    const processId = gentAccRes.data?.result?.processId;
    if (!processId) {
      const errMsg = gentAccRes.data?.result?.message || gentAccRes.data?.message || 'GentAcc: ไม่พบ processId ใน response';
      throw new Error(errMsg);
    }

    batchResult.processId = processId;
    batchResult.billOrderNumber = billOrderNumber;
    batchResult.stepStatus.GentAcc = 'success';

    sendEvent(sessionId, {
      type: 'step_done',
      step: 'GentAcc',
      status: 'success',
      data: { processId, billOrderNumber, totalBAs: count },
    });

    if (!activeRuns.has(sessionId)) {
      throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
    }

    // ── STEP 3: getBIP — รอจนกว่าสถานะ GentAcc ใน OPS จะเป็น Finish
    sendEvent(sessionId, {
      type: 'step_start',
      step: 'getBIP',
      message: `รอระบบ OPS ประมวลผล GentAcc ให้เสร็จสิ้น (Process ID: ${processId})...`,
    });

    for (let attempt = 1; attempt <= 10; attempt++) {
      if (!activeRuns.has(sessionId)) {
        throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
      }
      await sleep(1500);

      try {
        const bipRes = await axios.post(
          `${baseUrl}/api/v1/gentBIP/getBIP`,
          {
            firstLoadPage: 'F',
            pagination: { current: 1, pageSize: 25 },
            sorter: {},
          },
          { timeout: 15000 }
        );

        const items = bipRes.data?.result || [];
        const matched = Array.isArray(items) ? items.find(
          (item) => String(item.processId) === String(processId) ||
                    String(item.billOrderNumber) === String(billOrderNumber)
        ) : null;

        if (matched) {
          batchResult.processId = matched.processId || processId;
          batchResult.billOrderNumber = matched.billOrderNumber || billOrderNumber;
          if (matched.status === 'Finish' || (matched.status && !matched.status.includes('progress'))) {
            break;
          }
        }
      } catch (bipErr) {
        console.warn(`[getBIP Warning attempt ${attempt}] ${bipErr.message}. Continuing with processId ${processId}`);
      }
    }

    batchResult.stepStatus.getBIP = 'success';

    sendEvent(sessionId, {
      type: 'step_done',
      step: 'getBIP',
      status: 'success',
      data: {
        processId: batchResult.processId,
        billOrderNumber: batchResult.billOrderNumber,
      },
    });

    if (!activeRuns.has(sessionId)) {
      throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
    }

    // ── STEP 4 & 5: GentProforma and/or GentProduction
    const modeSetting = (config.billMode && config.billMode.trim()) || 'Auto';
    const shouldRunProforma = modeSetting === 'Auto' || modeSetting.toLowerCase() === 'proforma';
    const shouldRunProduction = modeSetting === 'Auto' || modeSetting.toLowerCase() === 'production';
    const prodUrl = `${baseUrl}/api/v1/invoicing/insertOPSInvoice`;

    if (shouldRunProforma) {
      if (!activeRuns.has(sessionId)) {
        throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
      }

      sendEvent(sessionId, {
        type: 'step_start',
        step: 'GentProforma',
        message: `ออกบิลร่าง Proforma (1 บิล ${count} BA) ยืนยัน Process ID: ${batchResult.processId}...`,
      });

      try {
        const pfRes = await axios.post(
          prodUrl,
          {
            process_id: batchResult.processId,
            bill_order_number: batchResult.billOrderNumber,
            task_program: 'BIP',
            bill_mode: 'Proforma',
            bill_cycle: batchResult.billCycle,
            create_by: creatorUuid,
            cutoff_date: cutOff.DDMMYYYY,
          },
          { timeout: 30000 }
        );

        const pfSeq = pfRes.data?.result?.proformaSeq;
        if (pfSeq != null) batchResult.proformaSeq = pfSeq;

        if (shouldRunProduction) {
          // รอให้สถานะ Proforma ใน OPS ประมวลผลเสร็จ (Finish) ก่อนปิดสเต็ป Proforma
          for (let pfWait = 1; pfWait <= 8; pfWait++) {
            if (!activeRuns.has(sessionId)) {
              throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
            }
            await sleep(1500);
            try {
              const bipRes = await axios.post(
                `${baseUrl}/api/v1/gentBIP/getBIP`,
                { firstLoadPage: 'F', pagination: { current: 1, pageSize: 25 }, sorter: {} },
                { timeout: 15000 }
              );
              const items = bipRes.data?.result || [];
              const matched = items.find(
                (item) => String(item.processId) === String(batchResult.processId)
              );
              if (matched && matched.status === 'Finish' && matched.billMode === 'Proforma') {
                break;
              }
            } catch (e) {}
          }
        }

        batchResult.stepStatus.GentProforma = 'success';

        sendEvent(sessionId, {
          type: 'step_done',
          step: 'GentProforma',
          status: 'success',
          data: { proformaSeq: pfSeq || 1, processId: batchResult.processId, billOrderNumber: batchResult.billOrderNumber },
        });
      } catch (pfErr) {
        const errMsg = pfErr.response?.data?.message || pfErr.message || 'Proforma Failed';
        console.warn(`[GentProforma Error] ${errMsg}`);
        batchResult.stepStatus.GentProforma = 'error';
        sendEvent(sessionId, {
          type: 'step_done',
          step: 'GentProforma',
          status: 'error',
          message: errMsg,
        });
        throw new Error(`GentProforma: ${errMsg}`);
      }
    }

    if (shouldRunProduction) {
      if (!activeRuns.has(sessionId)) {
        throw new Error('การทำงานถูกยกเลิกโดยผู้ใช้ (Aborted)');
      }

      sendEvent(sessionId, {
        type: 'step_start',
        step: 'GentProduction',
        message: `ยืนยันออกบิล Production (1 บิล ${count} BA) ยืนยัน Process ID: ${batchResult.processId}...`,
      });

      await axios.post(
        prodUrl,
        {
          process_id: batchResult.processId,
          bill_order_number: batchResult.billOrderNumber,
          task_program: 'BIP',
          bill_mode: 'Production',
          bill_cycle: batchResult.billCycle,
          create_by: creatorUuid,
          cutoff_date: cutOff.DDMMYYYY,
        },
        { timeout: 30000 }
      );

      batchResult.stepStatus.GentProduction = 'success';

      sendEvent(sessionId, {
        type: 'step_done',
        step: 'GentProduction',
        status: 'success',
        data: { billMode: 'Production', processId: batchResult.processId, billOrderNumber: batchResult.billOrderNumber },
      });
    }

    batchResult.status = 'success';

    // Build items for all BAs in this file (they all share this 1 bill order)
    const checkedMap = new Map((checkRes.data?.result || []).map(r => [String(r.billingAccount || ''), r]));
    for (const ba of baList) {
      const itemData = checkedMap.get(String(ba)) || {};
      batchResult.items.push({
        ba,
        billingAccount: itemData.billingAccount || ba,
        billCycle: itemData.billCycle || batchResult.billCycle,
        billGroup: extractBillGroupCode(itemData.billGroup) || batchResult.billGroup,
        cutOffDate: itemData.cutOffDate || batchResult.cutOffDate,
        processId: batchResult.processId,
        billOrderNumber: batchResult.billOrderNumber,
        proformaSeq: batchResult.proformaSeq,
        status: 'success',
        error: '',
      });
    }

    sendEvent(sessionId, { type: 'batch_complete', status: 'success', result: batchResult });
  } catch (err) {
    const stepFailed = Object.keys(batchResult.stepStatus).find(
      (s) => batchResult.stepStatus[s] === 'pending'
    );
    if (stepFailed) batchResult.stepStatus[stepFailed] = 'error';
    batchResult.status = 'error';
    batchResult.error =
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message ||
      'Unknown error';

    for (const ba of baList) {
      batchResult.items.push({
        ba,
        billingAccount: ba,
        billCycle: batchResult.billCycle,
        billGroup: batchResult.billGroup,
        cutOffDate: batchResult.cutOffDate,
        processId: batchResult.processId,
        billOrderNumber: batchResult.billOrderNumber,
        status: 'error',
        error: batchResult.error,
      });
    }

    sendEvent(sessionId, {
      type: 'batch_error',
      status: 'error',
      step: stepFailed,
      message: batchResult.error,
      result: batchResult,
    });
  }

  return batchResult;
}

// ─── Run automation (Supports Batch and Individual modes) ─────────────────────

app.post('/api/abort/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const wasRunning = activeRuns.has(sessionId);
  activeRuns.delete(sessionId);
  sendEvent(sessionId, {
    type: 'run_aborted',
    message: 'ผู้ใช้สั่งหยุดการทำงาน (Aborted)',
  });
  res.json({ ok: true, wasRunning });
});

app.post('/api/run', async (req, res) => {
  const { sessionId, bas, config, mode = 'batch' } = req.body;

  if (!sessionId || !bas || !config) {
    return res.status(400).json({ error: 'Missing sessionId, bas, or config' });
  }

  const baList = bas.map(b => String(b.ba || b).trim()).filter(Boolean);
  activeRuns.add(sessionId);

  // Respond immediately so client isn't waiting
  res.json({ started: true, count: baList.length, mode });

  if (mode === 'individual') {
    // ── MODE: 1 BA = 1 Bill Order ───────────────────────────────────────────
    (async () => {
      try {
        sendEvent(sessionId, {
          type: 'run_start',
          mode: 'individual',
          total: baList.length,
          totalBAs: baList.length,
          message: `เริ่มประมวลผลแบบแยก (1 BA = 1 บิล) ทั้งหมด ${baList.length} รายการ...`,
        });

        const results = [];
        let idx = 0;
        for (const ba of baList) {
          if (!activeRuns.has(sessionId)) {
            console.log(`[Run Aborted] Session ${sessionId} cancelled by user`);
            break;
          }
          idx++;
          sendEvent(sessionId, {
            type: 'ba_start',
            ba,
            index: idx,
            total: baList.length,
          });

          const r = await runIndividualBillingFlow(ba, config, sessionId, idx, baList.length);
          results.push(r);
        }

        // Build result Excel
        const wb = xlsx.utils.book_new();
        const wsData = [
          ['BA', 'Billing Account', 'Bill Cycle', 'Bill Group', 'Cut Off Date', 'Process ID', 'Bill Order Number', 'Proforma Seq', 'Status', 'Error'],
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
            r.proformaSeq || '-',
            r.status === 'success' ? 'Success ✅' : 'Failed ❌',
            r.error || '',
          ]);
        }

        const ws = xlsx.utils.aoa_to_sheet(wsData);
        ws['!cols'] = [
          { wch: 15 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
          { wch: 20 }, { wch: 30 }, { wch: 15 }, { wch: 12 }, { wch: 40 },
        ];
        xlsx.utils.book_append_sheet(wb, ws, 'Results');

        // Log sheet
        const logsSheet = xlsx.utils.json_to_sheet(runLogs.get(sessionId) || []);
        xlsx.utils.book_append_sheet(wb, logsSheet, 'Logs');

        const reportDir = path.join(__dirname, 'Data', 'Report');
        if (!fs.existsSync(reportDir)) {
          fs.mkdirSync(reportDir, { recursive: true });
        }
        const filename = `billing_results_individual_${Date.now()}.xlsx`;
        const fullPath = path.join(reportDir, filename);

        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        fs.writeFileSync(fullPath, buffer);
        sessionResults.set(sessionId, { buffer, filename, fullPath });

        const successCount = results.filter((r) => r.status === 'success').length;
        const failedCount = results.filter((r) => r.status !== 'success').length;

        sendEvent(sessionId, {
          type: 'all_done',
          mode: 'individual',
          total: baList.length,
          totalBAs: baList.length,
          success: successCount,
          failed: failedCount,
          downloadId: sessionId,
          filename: filename,
          savedPath: fullPath,
        });
      } finally {
        activeRuns.delete(sessionId);
      }
    })().catch((err) => {
      activeRuns.delete(sessionId);
      console.error(`[Fatal Run Error] Session ${sessionId}:`, err);
      sendEvent(sessionId, {
        type: 'run_fatal_error',
        message: err.message || 'เกิดข้อผิดพลาดในการประมวลผล',
      });
    });
  } else {
    // ── MODE: 1 File = 1 Bill Order ─────────────────────────────────────────
    (async () => {
      try {
        sendEvent(sessionId, {
          type: 'run_start',
          mode: 'batch',
          total: 1,
          totalBAs: baList.length,
          message: `เริ่มประมวลผล 1 บิล (${baList.length} BA)...`,
        });

        const batchResult = await runBatchBillingFlow(baList, config, sessionId);

        // Build result Excel
        const wb = xlsx.utils.book_new();
        const wsData = [
          ['BA', 'Billing Account', 'Bill Cycle', 'Bill Group', 'Cut Off Date', 'Process ID', 'Bill Order Number', 'Proforma Seq', 'Status', 'Error'],
        ];

        for (const r of batchResult.items) {
          wsData.push([
            r.ba,
            r.billingAccount,
            r.billCycle,
            r.billGroup,
            r.cutOffDate,
            r.processId,
            r.billOrderNumber,
            r.proformaSeq || '-',
            r.status === 'success' ? 'Success ✅' : 'Failed ❌',
            r.error || '',
          ]);
        }

        const ws = xlsx.utils.aoa_to_sheet(wsData);
        ws['!cols'] = [
          { wch: 15 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
          { wch: 20 }, { wch: 30 }, { wch: 15 }, { wch: 12 }, { wch: 40 },
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

        const isSuccess = batchResult.status === 'success';
        sendEvent(sessionId, {
          type: 'all_done',
          mode: 'batch',
          total: 1,
          totalBAs: baList.length,
          success: isSuccess ? 1 : 0,
          failed: isSuccess ? 0 : 1,
          billOrderNumber: batchResult.billOrderNumber,
          processId: batchResult.processId,
          downloadId: sessionId,
          filename: filename,
          savedPath: fullPath,
        });
      } finally {
        activeRuns.delete(sessionId);
      }
    })().catch((err) => {
      activeRuns.delete(sessionId);
      console.error(`[Fatal Run Error] Session ${sessionId}:`, err);
      sendEvent(sessionId, {
        type: 'run_fatal_error',
        message: err.message || 'เกิดข้อผิดพลาดในการประมวลผล',
      });
    });
  }
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
