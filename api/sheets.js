const { google } = require('googleapis');
const fetch = globalThis.fetch || require('node-fetch');

const SHEET_ID = process.env.SHEET_ID || '1I283wgYhF5L7FxF4hLyWwCe0kE1FHB1puNaPk_QeuyE';

const credentials = {
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  // A base64-kódolt változatot preferáljuk (GOOGLE_PRIVATE_KEY_B64), mert
  // abban nincs sortörés vagy speciális karakter, ami elromolhatna a Vercel
  // felületén való beillesztéskor. Ha az nincs beállítva, visszaesünk a
  // sima GOOGLE_PRIVATE_KEY változóra.
  private_key: process.env.GOOGLE_PRIVATE_KEY_B64
    ? Buffer.from(process.env.GOOGLE_PRIVATE_KEY_B64, 'base64').toString('utf8')
    : (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
};

async function getAuth() {
  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return auth;
}

// A jelenléti lap (csoportonkénti fül) sorait alakítja { gyerek: { dátum: true/false } } formára.
// Tűrő olvasás: a kis- vagy nagybetűs "x" (és körülötte szóköz) is jelenlétnek számít,
// és ha ugyanaz a gyerek-név vagy ugyanaz a dátum többször szerepel a lapon, az adatok
// összeadódnak (VAGY), nem írják felül egymást.
function buildAttendance(rows) {
  const dates = (rows[1] || []).slice(1); // 2. sor = dátumok (az A oszlop kihagyva)
  const childRows = rows.slice(2);        // 3. sortól = gyerekek
  const isMarked = (cell) => String(cell == null ? '' : cell).trim().toUpperCase() === 'X';

  const attendance = {};
  childRows.forEach(row => {
    const childName = row[0];
    if (!childName) return;
    if (!attendance[childName]) attendance[childName] = {};
    dates.forEach((date, i) => {
      if (!date) return;
      attendance[childName][date] = !!attendance[childName][date] || isMarked(row[i + 1]);
    });
  });
  return { dates, attendance };
}

// <fee-rule>
// Havidíj-szabály — UGYANEZ a kód fut az admin felületen, a szülői felületen és a számlázásnál.
// Egy gyerek díja egy adott (tanévi) hónapra:
//  - a beiratkozás előtti hónap, vagy a "nem jön"-nek jelölt hónap: 0 Ft
//  - a beiratkozás hónapja: alkalmak száma × havidíj ÷ 4 (az első óra ingyenes), de legfeljebb a teljes díj
//  - a beiratkozás hónapja / egy "nem jön" hónap utáni hónap: teljes díj
//  - egyébként az ELŐZŐ, már lezárt hónap jelenléte dönt:
//    0 alkalom = 0 Ft, 1 alkalom = fél díj, 2 vagy több alkalom = teljes díj
//  - ha az előző hónap még tart, vagy a jelenlét nem ismert (null/undefined): teljes díj
const FEE_MONTHS = ['09', '10', '11', '12', '01', '02', '03', '04', '05'];

// Egy dátum-fejléc hónapját adja vissza ("09"), tetszőleges elválasztóval is
// ("2026.09.02", "2026. 09. 02.", "2026-09-02").
function monthOfDate(d) {
  const m = String(d).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? m[2].padStart(2, '0') : '';
}

// Igaz, ha az adott tanévi hónap ("09".."05") utolsó napja már elmúlt.
function isMonthOver(mm, now = new Date()) {
  const m = parseInt(mm, 10);
  const schoolYearStart = (now.getMonth() + 1) >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  const year = m >= 9 ? schoolYearStart : schoolYearStart + 1;
  return now >= new Date(year, m, 1); // a következő hónap első napja
}

// "12, 02" vagy ["12","02"] -> ["12","02"]; csak érvényes tanévi hónapok maradnak.
function parseMonthList(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[^0-9]+/);
  return arr.map(x => String(x).trim()).filter(Boolean)
    .map(x => x.padStart(2, '0')).filter(x => FEE_MONTHS.includes(x));
}

function normMonth(v) {
  const l = parseMonthList(v);
  return l.length ? l[0] : '';
}

function hasFirstMonthSessions(child) {
  const n = child.firstMonthSessions;
  return !(n === null || n === undefined || n === '' || isNaN(Number(n)));
}

// 'before' = beiratkozás előtti hónap, 'skipped' = "nem jön", 'enroll' = beiratkozás hónapja, 'normal' = egyéb
function getMonthStatus(child, month) {
  const idx = FEE_MONTHS.indexOf(month);
  if (idx < 0) return 'normal';
  const enroll = normMonth(child.enrollMonth);
  if (enroll && idx < FEE_MONTHS.indexOf(enroll)) return 'before';
  if (parseMonthList(child.skipMonths).includes(month)) return 'skipped';
  if (enroll && month === enroll) return 'enroll';
  return 'normal';
}

function calcMonthFee(child, month, attData, now = new Date()) {
  const fee = parseInt(child.monthlyFee) || 0;
  const idx = FEE_MONTHS.indexOf(month);
  if (idx < 0 || fee <= 0) return fee;
  const status = getMonthStatus(child, month);
  if (status === 'before' || status === 'skipped') return 0;
  if (status === 'enroll') {
    if (!hasFirstMonthSessions(child)) return fee;
    return Math.min(fee, Math.round(fee * Number(child.firstMonthSessions) / 4));
  }
  if (idx === 0) return fee;
  const prev = FEE_MONTHS[idx - 1];
  if (getMonthStatus(child, prev) !== 'normal') return fee; // beiratkozás / "nem jön" utáni hónap
  if (attData == null) return fee;                          // a jelenlét nem ismert: nem találgatunk
  if (!isMonthOver(prev, now)) return fee;                  // az előző hónap még tart
  const present = Object.keys(attData).filter(d => monthOfDate(d) === prev && attData[d]).length;
  if (present === 0) return 0;
  return present === 1 ? Math.round(fee / 2) : fee;
}
// </fee-rule>

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Soha ne gyorsítótárazza a böngésző/Vercel a válaszokat — enélkül előfordulhatott,
  // hogy egy frissen mentett fizetés/jelenlét csak egy kemény oldal-újratöltés után
  // jelent meg, mert a korábbi (elavult) válasz jött vissza a cache-ből.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const { action } = req.query;

    // GET CHILDREN
    if (action === 'getChildren') {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gyerekek!A2:T1000',
      });
      const rows = response.data.values || [];
      const children = rows.filter(r => r[0]).map(r => ({
        name: r[0] || '',
        pin: r[1] || '',
        id: r[2] || '',
        group: r[3] || '',
        birthdate: r[4] || '',
        parentName: r[5] || '',
        parentPhone: r[6] || '',
        parentEmail: r[7] || '',
        billing: r[8] || '',
        childPhone: r[9] || '',
        childEmail: r[10] || '',
        monthlyFee: parseInt(r[11]) || 0,
        styles: r[12] ? r[12].split(',') : [],
        profileComplete: r[13] === 'Igen',
        postCode: r[14] || '',
        city: r[15] || '',
        paymentMethod: r[16] || 'wire_transfer',
        skipMonths: parseMonthList(r[17]),
        enrollMonth: normMonth(r[18]),
        firstMonthSessions: (r[19] === undefined || r[19] === '' || isNaN(Number(r[19]))) ? null : Number(r[19]),
      }));
      return res.status(200).json({ children });
    }

    // SAVE CHILD
    if (action === 'saveChild' && req.method === 'POST') {
      const c = req.body;
      // Find if child exists (by ID)
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gyerekek!A2:T1000',
      });
      const rows = existing.data.values || [];
      const rowIdx = rows.findIndex(r => r[2] === c.id);

      // VÉDELEM ID-ÜTKÖZÉS ELLEN: ha ez egy ÚJONNAN felvett gyerek (c.isNew),
      // de a generált ID már foglalt egy MÁSIK (más nevű) gyerek által a Sheet-ben,
      // akkor NEM írjuk felül azt a sort — ez korábban pontosan ezt okozta
      // (egy új gyerek felülírta egy másik meglévő gyerek adatait).
      if (c.isNew && rowIdx !== -1 && rows[rowIdx][0] && rows[rowIdx][0] !== c.name) {
        return res.status(200).json({ error: 'ID_UTKOZES', existingName: rows[rowIdx][0] });
      }

      // VÉDELEM PIN-ÜTKÖZÉS ELLEN: ha ez egy ÚJ gyerek, de a PIN kódja már
      // foglalt egy másik gyerek által, azt sem engedjük — a szülői belépő
      // különben rossz gyereket mutatna a PIN alapján.
      if (c.isNew) {
        const pinTaken = rows.some((r, i) => i !== rowIdx && r[1] === c.pin);
        if (pinTaken) {
          return res.status(200).json({ error: 'PIN_UTKOZES' });
        }
      }

      // Admin által állított mezők (havidíj, fizetési mód, "nem jön" hónapok, beiratkozás).
      // Ha a kérés nem tartalmazza őket (pl. a szülői felületről érkező profilmentés),
      // a Sheet-ben lévő értéket megtartjuk — így egy régi állapotról induló szülői mentés
      // nem írhatja felül az admin időközbeni módosítását.
      const ex = rowIdx !== -1 ? rows[rowIdx] : [];
      const monthlyFee = c.monthlyFee !== undefined ? c.monthlyFee : (parseInt(ex[11]) || 0);
      const paymentMethod = c.paymentMethod !== undefined ? (c.paymentMethod || 'wire_transfer') : (ex[16] || 'wire_transfer');
      const skipMonths = c.skipMonths !== undefined ? parseMonthList(c.skipMonths).join(',') : (ex[17] || '');
      const enrollMonth = c.enrollMonth !== undefined ? normMonth(c.enrollMonth) : (ex[18] || '');
      const firstMonthSessions = c.firstMonthSessions !== undefined
        ? ((c.firstMonthSessions === null || c.firstMonthSessions === '' || isNaN(Number(c.firstMonthSessions))) ? '' : Number(c.firstMonthSessions))
        : (ex[19] === undefined ? '' : ex[19]);

      const rowData = [[
        c.name, c.pin, c.id, c.group, c.birthdate,
        c.parentName, c.parentPhone, c.parentEmail, c.billing || c.billingAddress || '',
        c.childPhone, c.childEmail, monthlyFee,
        (c.styles || []).join(','),
        c.profileComplete ? 'Igen' : 'Nem',
        c.postCode || '', c.city || '', paymentMethod,
        skipMonths, enrollMonth, firstMonthSessions
      ]];

      if (rowIdx === -1) {
        // Append new row
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: 'Gyerekek!A2',
          valueInputOption: 'RAW',
          resource: { values: rowData },
        });
      } else {
        // Update existing row
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Gyerekek!A${rowIdx + 2}:T${rowIdx + 2}`,
          valueInputOption: 'RAW',
          resource: { values: rowData },
        });
      }
      return res.status(200).json({ success: true });
    }

    // DELETE CHILD
    if (action === 'deleteChild' && req.method === 'POST') {
      const { id, name } = req.body;
      
      // Delete from Gyerekek sheet
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gyerekek!A2:T1000',
      });
      const rows = existing.data.values || [];
      const rowIdx = rows.findIndex(r => r[2] === id);
      if (rowIdx !== -1) {
        await sheets.spreadsheets.values.clear({
          spreadsheetId: SHEET_ID,
          range: `Gyerekek!A${rowIdx + 2}:T${rowIdx + 2}`,
        });
      }

      // Delete from Fizetések sheet
      if (name) {
        const payExisting = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: 'Fizetések!A1:Z1000',
        });
        const payRows = payExisting.data.values || [];
        const payRowIdx = payRows.findIndex((r, i) => i > 0 && r[0] === name);
        if (payRowIdx !== -1) {
          await sheets.spreadsheets.values.clear({
            spreadsheetId: SHEET_ID,
            range: `Fizetések!A${payRowIdx + 1}:Z${payRowIdx + 1}`,
          });
        }
      }

      // Delete from all attendance sheets
      const attendanceSheets = ['Mesebalett', 'Közepesek', 'Péntekiek', 'Szombati nagyok'];
      for (const sheet of attendanceSheets) {
        try {
          const attExisting = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${sheet}!A1:ZZ1000`,
          });
          const attRows = attExisting.data.values || [];
          const attRowIdx = attRows.findIndex((r, i) => i > 1 && r[0] === name);
          if (attRowIdx !== -1) {
            await sheets.spreadsheets.values.clear({
              spreadsheetId: SHEET_ID,
              range: `${sheet}!A${attRowIdx + 1}:ZZ${attRowIdx + 1}`,
            });
          }
        } catch(e) {
          // Sheet might not exist, ignore
        }
      }

      return res.status(200).json({ success: true });
    }

    // GET ATTENDANCE
    if (action === 'getAttendance') {
      const { group } = req.query;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${group}!A1:ZZ1000`,
      });
      const rows = response.data.values || [];
      const { dates, attendance } = buildAttendance(rows);
      return res.status(200).json({ dates, attendance });
    }

    // GET CHILD PAYMENTS (for parent portal)
    if (action === 'getChildPayments') {
      const { childName } = req.query;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Fizetések!A1:Z1000',
      });
      const rows = response.data.values || [];
      const headers = rows[0] || [];
      const childRow = rows.find((r, i) => i > 0 && r[0] === childName);
      
      const payments = {};
      if (childRow) {
        headers.forEach((h, i) => {
          if (i >= 2 && h) {
            payments[h.replace('.', '').trim()] = childRow[i] === 'X' ? 'paid' : 'unpaid';
          }
        });
      }
      return res.status(200).json({ payments });
    }

    // GET PAYMENTS
    if (action === 'getPayments') {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Fizetések!A1:Z1000',
      });
      return res.status(200).json({ values: response.data.values || [] });
    }

    // SAVE PAYMENT
    if (action === 'savePayment' && req.method === 'POST') {
      const { childName, month, status } = req.body;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Fizetések!A1:Z1000',
      });
      const rows = response.data.values || [];
      const headers = rows[0] || [];
      
      // Find month column - strip dots from headers for comparison
      const cleanHeaders = headers.map(h => h.toString().replace('.', '').trim());
      let monthCol = cleanHeaders.indexOf(month.toString().trim());
      
      // If not found, add it
      if (monthCol === -1) {
        monthCol = headers.length;
        const col = String.fromCharCode(65 + monthCol);
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Fizetések!${col}1`,
          valueInputOption: 'RAW',
          resource: { values: [[month]] },
        });
      }

      // Find child row
      let childRow = rows.findIndex((r, i) => i > 0 && r[0] === childName);
      
      // If not found, add child with group
      if (childRow === -1) {
        childRow = rows.length;
        const { childGroup } = req.body;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Fizetések!A${childRow + 1}:B${childRow + 1}`,
          valueInputOption: 'RAW',
          resource: { values: [[childName, childGroup || '']] },
        });
      }

      const col = String.fromCharCode(65 + monthCol);
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Fizetések!${col}${childRow + 1}`,
        valueInputOption: 'RAW',
        resource: { values: [[status === 'paid' ? 'X' : '']] },
      });
      return res.status(200).json({ success: true });
    }

    // CREATE INVOICE (Billingo) — automatikus, NAV-kompatibilis számla kiállítása,
    // amikor az admin bepipálja egy gyerek havi fizetését.
    if (action === 'createInvoice' && req.method === 'POST') {
      const { childId, month } = req.body;

      const BILLINGO_API_KEY = process.env.BILLINGO_API_KEY;
      const BILLINGO_BLOCK_ID = process.env.BILLINGO_BLOCK_ID;
      const BILLINGO_BANK_ACCOUNT_ID = process.env.BILLINGO_BANK_ACCOUNT_ID;

      if (!BILLINGO_API_KEY || !BILLINGO_BLOCK_ID) {
        return res.status(200).json({ error: 'BILLINGO_NINCS_BEALLITVA' });
      }

      // Gyerek + szülő adatainak kikeresése a Gyerekek lapról
      const childrenResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gyerekek!A2:T1000',
      });
      const childRow = (childrenResp.data.values || []).find(r => r[2] === childId);
      if (!childRow) {
        return res.status(200).json({ error: 'GYEREK_NEM_TALALHATO' });
      }
      const childName = childRow[0] || '';
      const parentName = childRow[5] || childName;
      const parentEmail = childRow[7] || '';
      const billingStreet = childRow[8] || '';
      const monthlyFee = parseInt(childRow[11]) || 0;
      const postCode = childRow[14] || '';
      const city = childRow[15] || '';
      // Admin által beállított fizetési mód — alapértelmezetten átutalás,
      // de a szülő kérésére admin átállíthatja készpénzre (Gyerekek lap Q oszlopa).
      const paymentMethod = childRow[16] || 'wire_transfer';

      if (!monthlyFee) {
        return res.status(200).json({ error: 'NINCS_HAVIDIJ_MEGADVA' });
      }

      // A havidíj-szabályhoz szükséges, admin által beállított adatok
      const childFee = {
        monthlyFee,
        skipMonths: parseMonthList(childRow[17]),
        enrollMonth: normMonth(childRow[18]),
        firstMonthSessions: (childRow[19] === undefined || childRow[19] === '' || isNaN(Number(childRow[19]))) ? null : Number(childRow[19]),
      };
      const monthStatus = getMonthStatus(childFee, month);
      // "Nem jön"-nek jelölt hónapra, vagy a beiratkozás előtti hónapra nem készül számla
      if (monthStatus === 'before' || monthStatus === 'skipped') {
        return res.status(200).json({ error: 'NINCS_FIZETENDO' });
      }
      // A beiratkozás hónapjának díja az alkalmak számától függ — enélkül nem tudunk számlázni
      if (monthStatus === 'enroll' && !hasFirstMonthSessions(childFee)) {
        return res.status(200).json({ error: 'HIANYZIK_ALKALOM_SZAM', childName });
      }

      // Fizetendő összeg: a havidíj-szabály szerint. Normál hónapnál a jelenlétet a gyerek
      // csoportjának lapjáról olvassuk. Ha ez nem sikerül, inkább nem állítunk ki számlát,
      // mint hogy rossz összeggel készüljön el egy hivatalos számla.
      let attForCalc = null;
      if (monthStatus === 'normal' && FEE_MONTHS.indexOf(month) > 0) {
        const group = childRow[3] || '';
        let attRows;
        try {
          const attResp = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${group}!A1:ZZ1000`,
          });
          attRows = attResp.data.values || [];
        } catch (e) {
          console.error('Jelenlét olvasási hiba számlázáskor:', group, e.message);
          return res.status(200).json({ error: 'JELENLET_NEM_OLVASHATO', childName });
        }
        const { attendance } = buildAttendance(attRows);
        // Azonos nevű gyerekek megkülönböztetése — ugyanaz a kulcs, mint az admin/tanári oldalon
        const sameNameSameGroup = (childrenResp.data.values || [])
          .filter(r => r[0] === childName && r[3] === group)
          .sort((a, b) => (a[2] || '').localeCompare(b[2] || ''));
        const attKey = sameNameSameGroup.length > 1
          ? `${childName} (${sameNameSameGroup.findIndex(r => r[2] === childId) + 1})`
          : childName;
        attForCalc = attendance[attKey] || attendance[childName] || {};
      }
      const amountDue = calcMonthFee(childFee, month, attForCalc);

      // 0 Ft fizetendő (pl. az előző hónapban nem járt) -> nincs mit számlázni
      if (amountDue <= 0) {
        return res.status(200).json({ error: 'NINCS_FIZETENDO' });
      }

      // A Billingo kötelezően kéri az irányítószámot és a várost külön mezőben —
      // ezek nélkül a partner létrehozása elutasításra kerül. Ha ezek hiányoznak
      // a gyerek profiljából, itt megállunk, és pontosan megmondjuk kinél kell
      // pótolni, ahelyett hogy cím nélkül (érvénytelenül) próbálnánk számlázni.
      if (!postCode || !city) {
        return res.status(200).json({ error: 'HIANYZIK_CIM', childName });
      }

      const parsedAddress = {
        country_code: 'HU',
        post_code: postCode,
        city: city,
        address: billingStreet || city,
      };

      const billingoHeaders = {
        'X-API-KEY': BILLINGO_API_KEY,
        'Content-Type': 'application/json',
      };

      // 1. Partner keresése — email alapján, ha van; ha nincs, név alapján
      // (mivel a Billingo partnerlista tiszta, ez biztonságos)
      let partnerId = null;
      const searchTerm = parentEmail || parentName;
      if (searchTerm) {
        const searchResp = await fetch(`https://api.billingo.hu/v3/partners?query=${encodeURIComponent(searchTerm)}`, {
          headers: billingoHeaders,
        });
        const searchData = await searchResp.json();
        if (searchResp.ok && searchData && Array.isArray(searchData.data) && searchData.data.length > 0) {
          // Név alapú keresésnél csak PONTOS egyezést fogadunk el, hogy ne
          // keverjünk össze két hasonló nevű, de különböző szülőt.
          const exact = searchData.data.find(p =>
            (parentEmail && p.emails && p.emails.includes(parentEmail)) ||
            (p.name && p.name.trim().toLowerCase() === parentName.trim().toLowerCase())
          );
          partnerId = exact ? exact.id : null;
        }
      }

      if (!partnerId) {
        const partnerResp = await fetch('https://api.billingo.hu/v3/partners', {
          method: 'POST',
          headers: billingoHeaders,
          body: JSON.stringify({
            name: parentName,
            emails: parentEmail ? [parentEmail] : [],
            address: parsedAddress || undefined,
          }),
        });
        const partnerData = await partnerResp.json();
        if (!partnerResp.ok) {
          console.error('Billingo partner hiba:', JSON.stringify(partnerData));
          return res.status(200).json({ error: 'BILLINGO_PARTNER_HIBA', details: partnerData });
        }
        partnerId = partnerData.id;
      }

      // 2. Számla létrehozása, kifizetettként (mivel az admin csak akkor hívja ezt,
      // amikor már bepipálta, hogy a szülő fizetett). Nincs automatikus e-mail
      // kiküldés (electronic: false) — a számla csak elkészül a Billingo-ban.
      const monthNames = { '09':'szeptember','10':'október','11':'november','12':'december','01':'január','02':'február','03':'március','04':'április','05':'május' };
      const today = new Date().toISOString().split('T')[0];

      const invoiceBody = {
        partner_id: partnerId,
        block_id: parseInt(BILLINGO_BLOCK_ID),
        ...(BILLINGO_BANK_ACCOUNT_ID ? { bank_account_id: parseInt(BILLINGO_BANK_ACCOUNT_ID) } : {}),
        type: 'invoice',
        fulfillment_date: today,
        due_date: today,
        payment_method: paymentMethod,
        language: 'hu',
        currency: 'HUF',
        electronic: false,
        paid: true,
        items: [{
          name: `Táncoktatás — ${childName} (${monthNames[month] || month})`,
          unit_price: amountDue,
          unit_price_type: 'gross',
          quantity: 1,
          unit: 'hó',
          vat: 'AAM',
        }],
        comment: 'Basic Táncstúdió havi tandíj',
      };

      const invoiceResp = await fetch('https://api.billingo.hu/v3/documents', {
        method: 'POST',
        headers: billingoHeaders,
        body: JSON.stringify(invoiceBody),
      });
      const invoiceData = await invoiceResp.json();
      if (!invoiceResp.ok) {
        console.error('Billingo számla hiba:', JSON.stringify(invoiceData));
        return res.status(200).json({ error: 'BILLINGO_SZAMLA_HIBA', details: invoiceData });
      }

      // 3. Számla kiküldése emailben a szülőnek, ha van megadva email cím.
      // Ez egy külön Billingo végpont — a számla létrehozása önmagában nem küld ki semmit.
      let emailSent = false;
      if (parentEmail && invoiceData && invoiceData.id) {
        const emailResp = await fetch(`https://api.billingo.hu/v3/documents/${invoiceData.id}/send`, {
          method: 'POST',
          headers: billingoHeaders,
          body: JSON.stringify({ emails: [parentEmail] }),
        });
        emailSent = emailResp.ok;
        if (!emailResp.ok) {
          console.error('Billingo email küldési hiba:', await emailResp.text());
        }
      }

      return res.status(200).json({ success: true, invoice: invoiceData, emailSent });
    }
    if (action === 'saveAttendance' && req.method === 'POST') {
      const { childName, group, date, present } = req.body;
      const sheetName = group;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${sheetName}!A1:ZZ1000`,
      });
      const rows = response.data.values || [];
      const headers = rows[1] || [];
      let dateCol = headers.indexOf(date);

      // Add date column if not exists
      if (dateCol === -1) {
        dateCol = headers.length;
        // JAVÍTVA: itt korábban egy felesleges "+1" volt a képletben, ami miatt
        // minden UGYANAZON a napon történő MÁSODIK (és további) bejelentkezés
        // egy oszloppal arrébb, dátum-fejléc nélkül íródott be a Sheet-be.
        const col = String.fromCharCode(65 + dateCol);
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${sheetName}!${col}2`,
          valueInputOption: 'RAW',
          resource: { values: [[date]] },
        });
      }

      // Find child row
      let childRow = rows.findIndex((r, i) => i > 1 && r[0] === childName);
      if (childRow === -1) {
        childRow = rows.length;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${sheetName}!A${childRow + 1}`,
          valueInputOption: 'RAW',
          resource: { values: [[childName]] },
        });
      }

      const col = String.fromCharCode(65 + dateCol);
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${sheetName}!${col}${childRow + 1}`,
        valueInputOption: 'RAW',
        // present === false esetén (pipa visszavétele az adminon) kiürítjük a
        // cellát, egyébként X-et írunk. Korábban ez az eset egyáltalán nem
        // volt kezelve, ezért a visszavett pipa sosem törlődött a Sheet-ből.
        resource: { values: [[present === false ? '' : 'X']] },
      });
      return res.status(200).json({ success: true });
    }

    // SAVE ABSENCE
    if (action === 'saveAbsence' && req.method === 'POST') {
      const { childName, group, date, message } = req.body;
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Hiányzások!A2',
        valueInputOption: 'RAW',
        resource: { values: [[
          new Date().toLocaleString('hu-HU'),
          childName,
          group,
          date,
          message || '',
          'Új'
        ]] },
      });
      return res.status(200).json({ success: true });
    }

    // GET ABSENCES
    if (action === 'getAbsences') {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Hiányzások!A2:F1000',
      });
      const rows = response.data.values || [];
      const absences = rows.filter(r => r[1]).map(r => ({
        reportedAt: r[0] || '',
        childName: r[1] || '',
        group: r[2] || '',
        date: r[3] || '',
        message: r[4] || '',
        status: r[5] || 'Új'
      }));
      return res.status(200).json({ absences });
    }

    // UPDATE ABSENCE STATUS
    if (action === 'updateAbsenceStatus' && req.method === 'POST') {
      const { rowIndex, status } = req.body;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Hiányzások!F${rowIndex + 2}`,
        valueInputOption: 'RAW',
        resource: { values: [[status]] },
      });
      return res.status(200).json({ success: true });
    }

    // DELETE GALA SEAT
    if (action === 'deleteGalaSeat' && req.method === 'POST') {
      const { childName, seat } = req.body;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gála foglalások!A2:F1000',
      });
      const rows = response.data.values || [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][1] === childName && rows[i][3] && rows[i][3].includes(seat)) {
          const seats = rows[i][3].split(', ').filter(s => s.trim() !== seat);
          if (seats.length === 0) {
            // Clear entire row
            await sheets.spreadsheets.values.clear({
              spreadsheetId: SHEET_ID,
              range: `Gála foglalások!A${i + 2}:F${i + 2}`,
            });
          } else {
            // Update seats
            await sheets.spreadsheets.values.update({
              spreadsheetId: SHEET_ID,
              range: `Gála foglalások!D${i + 2}:E${i + 2}`,
              valueInputOption: 'RAW',
              resource: { values: [[seats.join(', '), seats.length]] },
            });
          }
          break;
        }
      }
      return res.status(200).json({ success: true });
    }

    // SAVE SITE DATA (teachers, ages, gallery)
    if (action === 'saveSiteData' && req.method === 'POST') {
      const { key, value } = req.body;
      
      // Find existing row for this key, or append new
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Weboldal!A1:A100',
      });
      const rows = existing.data.values || [];
      const rowIdx = rows.findIndex(r => r[0] === key);
      
      if (rowIdx !== -1) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Weboldal!A${rowIdx + 1}:B${rowIdx + 1}`,
          valueInputOption: 'RAW',
          resource: { values: [[key, JSON.stringify(value)]] },
        });
      } else {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: 'Weboldal!A1',
          valueInputOption: 'RAW',
          resource: { values: [[key, JSON.stringify(value)]] },
        });
      }
      return res.status(200).json({ success: true });
    }

    // GET SITE DATA
    if (action === 'getSiteData') {
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: 'Weboldal!A1:B100',
        });
        const rows = response.data.values || [];
        const data = {};
        rows.forEach(r => { 
          if (r[0] && r[1]) { 
            try { data[r[0]] = JSON.parse(r[1]); } catch(e) {} 
          } 
        });
        return res.status(200).json({ data });
      } catch(e) {
        return res.status(200).json({ data: {} });
      }
    }

    // UPLOAD IMAGE TO CLOUDINARY
    if (action === 'uploadImage' && req.method === 'POST') {
      const { v2: cloudinary } = require('cloudinary');
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });

      const { imageData, folder } = req.body;
      const uploadResult = await cloudinary.uploader.upload(imageData, {
        folder: folder || 'basic-tancstudio',
      });

      if (uploadResult.secure_url) {
        return res.status(200).json({ url: uploadResult.secure_url, publicId: uploadResult.public_id });
      } else {
        return res.status(500).json({ error: 'Upload failed' });
      }
    }

    // GET BOOKED SEATS
    if (action === 'getBookedSeats') {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gála foglalások!D2:D1000',
      });
      const rows = response.data.values || [];
      const bookedSeats = [];
      rows.forEach(row => {
        if (row[0]) {
          row[0].split(', ').forEach(seat => bookedSeats.push(seat.trim()));
        }
      });
      return res.status(200).json({ bookedSeats });
    }

    // GET GALA BOOKINGS
    if (action === 'getGalaBookings') {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gála foglalások!A2:G1000',
      });
      const rows = response.data.values || [];
      const bookings = rows.filter(r => r[1]).map(r => ({
        date: r[0] || '',
        childName: r[1] || '',
        email: r[2] || '',
        seats: r[3] ? r[3].split(', ') : [],
        count: parseInt(r[4]) || 0,
        level: r[5] || '',
        paid: r[6] === 'X'
      }));
      return res.status(200).json({ bookings });
    }

    // SAVE GALA PAID STATUS (korábban ez teljesen hiányzott — a pipálás
    // csak a böngészőben élt, frissítéskor elveszett)
    if (action === 'saveGalaPaid' && req.method === 'POST') {
      const { childName, paid } = req.body;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gála foglalások!A2:G1000',
      });
      const rows = response.data.values || [];
      const rowIdx = rows.findIndex(r => r[1] === childName);
      if (rowIdx !== -1) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Gála foglalások!G${rowIdx + 2}`,
          valueInputOption: 'RAW',
          resource: { values: [[paid ? 'X' : '']] },
        });
      }
      return res.status(200).json({ success: true });
    }

    // SAVE GALA BOOKING
    if (action === 'saveGalaBooking' && req.method === 'POST') {
      const { childName, email, seats } = req.body;

      // Frissen, közvetlenül mentés előtt ellenőrizzük, foglalt-e már bármelyik
      // kért szék — ez akadályozza meg, hogy két szülő majdnem egyszerre
      // ugyanazt a helyet foglalja le (korábban ez nem volt ellenőrizve).
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gála foglalások!D2:D1000',
      });
      const existingRows = existing.data.values || [];
      const takenSeats = new Set();
      existingRows.forEach(row => {
        if (row[0]) row[0].split(', ').forEach(s => takenSeats.add(s.trim()));
      });
      const conflictSeats = seats.filter(s => takenSeats.has(s));
      if (conflictSeats.length > 0) {
        return res.status(200).json({ error: 'SZEKEK_FOGLALTAK', conflictSeats });
      }

      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Gála foglalások!A2',
        valueInputOption: 'RAW',
        resource: { values: [[
          new Date().toLocaleString('hu-HU'),
          childName, email,
          seats.join(', '),
          seats.length,
          seats[0]?.includes('Erkély') ? 'Erkély' : 'Földszint'
        ]] },
      });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (error) {
    console.error('Sheets API error:', error);
    return res.status(500).json({ error: error.message });
  }
}
