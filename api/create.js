import axios from "axios";

const FIREBASE_SIGNUP_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaSyBQNjlw9Vp4tP4VVeANzyPJnqbG2wLbYPw";
const MAILTM_BASE = "https://api.mail.tm";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Creazione account mail temporanea
    const domainRes = await axios.get(`${MAILTM_BASE}/domains`);
    const domains = domainRes.data["hydra:member"];
    if (!domains?.length) throw new Error("No mail.tm domains found");
    const domain = domains[0].domain;
    const randomName = Math.random().toString(36).substring(2, 10);
    const email = `${randomName}@${domain}`;
    const password = Math.random().toString(36).substring(2, 12);

    // Registrazione su mail.tm
    await axios.post(`${MAILTM_BASE}/accounts`, { address: email, password }).catch(() => {});
    const tokenRes = await axios.post(`${MAILTM_BASE}/token`, { address: email, password });
    const mailToken = tokenRes.data.token;

    // Creazione account Firebase
    await axios.post(FIREBASE_SIGNUP_URL, {
      email,
      password,
      returnSecureToken: true,
    });

    // Richiesta invio email di verifica
    const idToken = (await axios.post(FIREBASE_SIGNUP_URL, {
      email,
      password,
      returnSecureToken: true,
    })).data.idToken;

    await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=AIzaSyBQNjlw9Vp4tP4VVeANzyPJnqbG2wLbYPw`,
      { requestType: "VERIFY_EMAIL", idToken }
    );

    // Polling della casella per trovare il link
    let verificationLink = null;
    const deadline = Date.now() + 60000; // Ridotto a 60s per evitare timeout di Vercel

    while (Date.now() < deadline && !verificationLink) {
      const inbox = await axios.get(`${MAILTM_BASE}/messages`, {
        headers: { Authorization: `Bearer ${mailToken}` },
      });
      const messages = inbox.data["hydra:member"] || [];
      const msg = messages.find((m) =>
        (m.subject || "").toLowerCase().includes("verify")
      );
      if (msg) {
        const full = await axios.get(`${MAILTM_BASE}/messages/${msg.id}`, {
          headers: { Authorization: `Bearer ${mailToken}` },
        });
        const html = String(full.data.html || full.data.text || "");
        const linkMatch = html.match(/https?:\/\/[^\s"'<>]*oobCode[^\s"'<>]*/g);
        if (linkMatch?.length) {
          verificationLink = linkMatch[0];
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (!verificationLink)
      return res.status(200).json({
        status: "waiting",
        message: "Timeout: no verification email found within 60s.",
        email,
        password,
      });

    return res.status(200).json({
      status: "success",
      email,
      password,
      verificationLink,
    });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({
      error: err.response?.data || err.message || "Unknown error",
    });
  }
}
