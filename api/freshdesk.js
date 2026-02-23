export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const path = req.query.path;
  if (!path) {
    return res.status(400).json({ error: 'Missing "path" query parameter' });
  }

  const fdKey = req.headers['x-fd-key'];
  if (!fdKey) {
    return res.status(401).json({ error: 'Missing x-fd-key header' });
  }

  const url = `https://bookleafpublishing.freshdesk.com/api/v2/${path}`;
  const auth = Buffer.from(fdKey + ':X').toString('base64');

  const fetchOptions = {
    method: req.method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  };

  if (req.method === 'PUT' && req.body) {
    fetchOptions.body = JSON.stringify(req.body);
  }

  try {
    const response = await fetch(url, fetchOptions);
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Freshdesk API request failed', detail: err.message });
  }
}
