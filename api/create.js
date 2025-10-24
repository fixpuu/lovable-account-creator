import axios from "axios";

const FIREBASE_SIGNUP_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaSyBQNjlw9Vp4tP4VVeANzyPJnqbG2wLbYPw";
const FIREBASE_VERIFY_URL = 
  "https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=AIzaSyBQNjlw9Vp4tP4VVeANzyPJnqbG2wLbYPw";
const MAILTM_BASE = "https://api.mail.tm";

export default async function handler(req, res) {
  // Abilita CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    console.log("Starting account creation process...");

    // 1. Creazione account mail temporanea
    console.log("Fetching mail.tm domains...");
    const domainRes = await axios.get(`${MAILTM_BASE}/domains`);
    const domains = domainRes.data["hydra:member"];
    
    if (!domains || domains.length === 0) {
      throw new Error("No mail.tm domains found");
    }
    
    const domain = domains[0].domain;
    const randomName = Math.random().toString(36).substring(2, 10);
    const email = `${randomName}@${domain}`;
    const password = Math.random().toString(36).substring(2, 12);

    console.log(`Generated email: ${email}`);

    // 2. Registrazione su mail.tm
    console.log("Registering mail.tm account...");
    try {
      await axios.post(`${MAILTM_BASE}/accounts`, { 
        address: email, 
        password 
      });
    } catch (err) {
      console.log("Mail.tm account may already exist, continuing...");
    }

    // 3. Ottenere token mail.tm
    console.log("Getting mail.tm token...");
    const tokenRes = await axios.post(`${MAILTM_BASE}/token`, { 
      address: email, 
      password 
    });
    const mailToken = tokenRes.data.token;

    // 4. Creazione account Firebase
    console.log("Creating Firebase account...");
    const firebaseRes = await axios.post(FIREBASE_SIGNUP_URL, {
      email,
      password,
      returnSecureToken: true,
    });

    const idToken = firebaseRes.data.idToken;
    console.log("Firebase account created, idToken obtained");

    // 5. Richiesta invio email di verifica
    console.log("Requesting verification email...");
    await axios.post(FIREBASE_VERIFY_URL, { 
      requestType: "VERIFY_EMAIL", 
      idToken 
    });

    console.log("Verification email requested, starting polling...");

    // 6. Polling della casella per trovare il link
    let verificationLink = null;
    const deadline = Date.now() + 60000; // 60 secondi
    let attempts = 0;

    while (Date.now() < deadline && !verificationLink) {
      attempts++;
      console.log(`Polling attempt ${attempts}...`);

      try {
        const inbox = await axios.get(`${MAILTM_BASE}/messages`, {
          headers: { Authorization: `Bearer ${mailToken}` },
        });

        const messages = inbox.data["hydra:member"] || [];
        console.log(`Found ${messages.length} messages`);

        const msg = messages.find((m) =>
          (m.subject || "").toLowerCase().includes("verify")
        );

        if (msg) {
          console.log(`Found verification message: ${msg.id}`);
          const full = await axios.get(`${MAILTM_BASE}/messages/${msg.id}`, {
            headers: { Authorization: `Bearer ${mailToken}` },
          });

          const html = String(full.data.html || full.data.text || "");
          const linkMatch = html.match(/https?:\/\/[^\s"'<>]*oobCode[^\s"'<>]*/g);

          if (linkMatch && linkMatch.length > 0) {
            verificationLink = linkMatch[0];
            console.log("Verification link found!");
            break;
          }
        }
      } catch (pollErr) {
        console.log(`Polling error: ${pollErr.message}`);
      }

      if (!verificationLink) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    if (!verificationLink) {
      console.log("Timeout: no verification email found");
      return res.status(200).json({
        status: "waiting",
        message: "Timeout: no verification email found within 60s. Check manually.",
        email,
        password,
      });
    }

    console.log("Process completed successfully!");
    return res.status(200).json({
      status: "success",
      email,
      password,
      verificationLink,
    });

  } catch (err) {
    console.error("Error occurred:");
    console.error("Message:", err.message);
    console.error("Response data:", err.response?.data);
    console.error("Status:", err.response?.status);
    
    return res.status(500).json({
      error: err.message,
      details: err.response?.data || "No additional details",
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}
