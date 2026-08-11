const { google } = require('googleapis');

const SHEET_ID = '1I283wgYhF5L7FxF4hLyWwCe0kE1FHB1puNaPk_QeuyE';

const credentials = {
  client_email: 'basic01@basic01-505212.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDNnmVLeFflKNZR\niVFv5eoBzkOxiR8J9s923McuU3z7HWhSPzmNzEpm2mYjj/GM+09d/FwDfFjlznOg\nuwwMhHLF0XqetdM3UB94fz2KKpA9ibKejAsfBpl8v5GvSAJbZSPFTc4jetMKcGaM\newYBhmq77VCffkVqmNlFgOILnuJi6Ft7TxTbiuzG223jgJatHPYSiyU4IUloXaUD\nJjETButiFSnKsMWFLGyEJQxbQ6Z8+DLHPoJVFB9UfMR9ypXdNvg/tKydqkqU6EhF\nuJKsf2edp9n9WUe0jGFwFQiVFIhF+BOgxtNp/P8u/j2qj9gXTIjvNRZycG4kL/iC\nwKJgbqgNAgMBAAECggEATKyovDxbll4kkVIh9panLNY0QwNNekM5eOr6MWm7nM6K\nBMWD2j8YbYM6fD9khTx/i54b18bqRYO3dXPamd5YCDFFxuIpqaIsohvcoGWf1PrA\ni0PQr9ifqrerBVBWZKtx69TILk3SXb2tV+xWQIJV0c88dcU58Haf6r2VTV0JsXSl\nhKskjhMZmy2vOV0YI3ot68T+f90sc7cYPHVIf+4DNgumYkOv+C2ywKMYIISZatah\nFodArjbDusJIKoKF+LDhtJOzYiV+WK4j4txvtxP/uyoeSnp4i6MuI6Od5Sd5eefA\nRbiaSgtsNiw4Y6b6bNBdw9oNhWKJB+RGXvudSTR/xwKBgQD2FUc6DO7GRkgnzPQf\nFnDltg/xmvNgAiW2yRx0XBtNLm0qJaJXTWuMgtgo+FwY1Ax4Oft8G0hxUxNaBVYD\nUsI5pKqaojyOsVUImpps1eqmxAmkcZM6ugN2WKj+rb5dhA1lmuDMm7kgiJEtMdtx\nxlMG1jELqxGqoNNXrg7jfrkDZwKBgQDV56pvEmN7hZsJd5fysXhDxkGYYzpyguY3\n/ODAytwk/zvzvuiaFEREYYHCaLSXgdunueCvfFBu9w6N3Ql2gxKPlnkdInn9dl2H\n4oyunnPKJSl6eOepDcqQYKQ6SpYAgbjLbsM47ambr5e1YpURO6o1pEKiGZsQxjeR\nt7GUmEpkawKBgQCOb/aQZVf4MEonr3xGWkjyzZUg9d2VXujRiksMFxw+ancJhEsZ\nWVi9NidEX61/OY4WMQmd5nTiE4IKAzisJ8UAdI3Df9Cpj392wXZNNOzjpmkmZA8i\nWPUUFXGMKKkdnAfdHe6swB5B9IqDrG4mxvLb7DLrXBOXvgtWnwtDJuCUVQKBgD3k\nmZEn/fcY0qJro2DK7ySVMhe45omJzLl4h0Phrs9ZtuwxWjZzFMnAeP5as55/KaKf\nix7b1p41CFYOFhXfmThI7uR6PFgVrryJ1fEU0iY0mIrifw2QewNJo1tmh37ACkt6\n0iwfwIrWxQvr6XwiCn8Y91rWE+NHp36Xa1+2rRffAoGAEfucI17tgahMMkVpG9+c\nTqm9uOkN0qgVsDQ5zWPLnhZprKWV74wjL68DJOoYOXdFfPYLGZrYLNaIn0BSq31C\nxBtgP4uZ4KSUsGEioZkXb2sCw8FGjvuBp3725+d7Uebgy12H3Sf/T3O9yPKxTVdU\nPkYqXqF+8N5DKewlS1cpw+w=\n-----END PRIVATE KEY-----\n',
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
      const rowData = [[
        c.name, c.pin, c.id, c.group, c.birthdate,
        c.parentName, c.parentPhone, c.parentEmail, c.billing,
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
      const { id } = req.body;
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
      return res.status(200).json({ success: true });
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
      const monthCol = headers.indexOf(month);
      const childRow = rows.findIndex((r, i) => i > 0 && r[0] === childName);

      if (monthCol !== -1 && childRow !== -1) {
        const col = String.fromCharCode(65 + monthCol);
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Fizetések!${col}${childRow + 1}`,
          valueInputOption: 'RAW',
          resource: { values: [[status === 'paid' ? 'X' : '']] },
        });
      }
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

    // SAVE GALA BOOKING
    if (action === 'saveGalaBooking' && req.method === 'POST') {
      const { childName, email, seats } = req.body;
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
