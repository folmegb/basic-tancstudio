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

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const { action } = req.query;

    // GET CHILDREN
    if (action === 'getChildren') {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gyerekek!A2:N1000',
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
      }));
      return res.status(200).json({ children });
    }

    // SAVE CHILD
    if (action === 'saveChild' && req.method === 'POST') {
      const c = req.body;
      // Find if child exists (by ID)
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Gyerekek!A2:N1000',
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

      const rowData = [[
        c.name, c.pin, c.id, c.group, c.birthdate,
        c.parentName, c.parentPhone, c.parentEmail, c.billing || c.billingAddress || '',
        c.childPhone, c.childEmail, c.monthlyFee,
        (c.styles || []).join(','),
        c.profileComplete ? 'Igen' : 'Nem'
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
          range: `Gyerekek!A${rowIdx + 2}:N${rowIdx + 2}`,
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
        range: 'Gyerekek!A2:N1000',
      });
      const rows = existing.data.values || [];
      const rowIdx = rows.findIndex(r => r[2] === id);
      if (rowIdx !== -1) {
        await sheets.spreadsheets.values.clear({
          spreadsheetId: SHEET_ID,
          range: `Gyerekek!A${rowIdx + 2}:N${rowIdx + 2}`,
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
      const dates = (rows[1] || []).slice(1); // Row 2 = dates
      const childRows = rows.slice(2); // Row 3+ = children
      
      const attendance = {};
      childRows.forEach(row => {
        const childName = row[0];
        if (!childName) return;
        attendance[childName] = {};
        dates.forEach((date, i) => {
          if (date) attendance[childName][date] = row[i + 1] === 'X';
        });
      });
      
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

    // SAVE ATTENDANCE
    if (action === 'saveAttendance' && req.method === 'POST') {
      const { childName, group, date } = req.body;
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
        const col = String.fromCharCode(65 + dateCol + 1);
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

      const col = String.fromCharCode(65 + dateCol + 1);
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${sheetName}!${col}${childRow + 1}`,
        valueInputOption: 'RAW',
        resource: { values: [['X']] },
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
