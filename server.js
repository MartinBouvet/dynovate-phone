// server.js
require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const axios = require('axios');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');

const app = express();

// ---------- CONFIG / ENV ----------
const PORT = process.env.PORT || 3000;
const RAILWAY_PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || null;
const BASE_URL = process.env.BASE_URL || (RAILWAY_PUBLIC_DOMAIN ? `https://${RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);

// Groq
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY || 'gsk_dummy_key_for_init'
});

// ElevenLabs flag
const USE_ELEVENLABS = process.env.USE_ELEVENLABS === 'true';
const ELEVENLABS_API_KEY = USE_ELEVENLABS ? process.env.ELEVENLABS_API_KEY : null;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'ThT5KcBeYPX3keUQqHPh';

// Twilio client (only if configured for future SMS usage — not required)
let twilioClient = null;
if (process.env.TWILIO_SID && process.env.TWILIO_AUTH) {
    try {
        twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
    } catch (e) {
        console.warn('⚠️ Twilio init failed:', e.message);
        twilioClient = null;
    }
}

// Nodemailer transporter (email feature)
let emailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
        emailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        console.log('📧 Email configuré avec succès');
    } catch (error) {
        console.error('❌ Erreur configuration email:', error.message);
        emailTransporter = null;
    }
} else {
    console.log('ℹ️ Email non configuré (EMAIL_USER / EMAIL_PASS manquants)');
}

// Ensure reports folder exists for local fallback
(async () => {
    try {
        await fs.mkdir(path.join(__dirname, 'reports'), { recursive: true });
    } catch (e) {
        console.warn('Impossible de créer dossier reports:', e.message);
    }
})();

// ---------- GLOBAL STORAGE ----------
global.audioQueue = {};            // token -> text to TTS
global.streamingResponses = {};    // callSid -> boolean (flow control)

// Conversations & profiles
const conversations = new Map();   // callSid -> [{role, content},...]
const userProfiles = new Map();    // callSid -> { phone, startTime, interactions, email, sector, rdvRequested, rdvStage }
const responseCache = new Map();   // key -> { response, timestamp }
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------- DYNOVATE CONTEXT ----------
const DYNOVATE_CONTEXT = `Tu es Dynophone, expert commercial chez Dynovate spécialisée en IA pour la relation client.

DYNOVATE - SOLUTIONS IA:
1. IA Réseaux Sociaux: Automatise les réponses 24h/7j
2. IA Email: Classe/répond/relance automatiquement
3. IA Téléphonique: Comme moi, disponible 24h/7j
4. IA Chatbot Web: Guide visiteurs

OBJECTIFS:
- Qualifier besoins (secteur, problématiques)
- Collecter EMAIL obligatoirement pour suivi
- Pour RDV: TOUJOURS demander l'email d'abord, puis dire \"Je vous envoie le lien de réservation par email\"

RÈGLES:
- Réponses TRÈS COURTES: 15 mots maximum
- Une question à la fois
- Si demande RDV sans email: \"Pour vous envoyer le lien, quel est votre email ?\"
- Détecter fin: \"merci\", \"au revoir\" → ajoute \"FIN_APPEL\"

Sois rapide, précis, efficace.`;

// ---------- QUICK RESPONSES (strict matching + useful flows) ----------
const QUICK_RESPONSES = {
    patterns: [
        {
            // exact "bonjour"
            regex: /^\s*bonjour\s*$/i,
            response: "Bonjour ! Dynophone de Dynovate. Comment puis-je vous aider ?"
        },
        {
            // exact "salut"
            regex: /^\s*salut\s*$/i,
            response: "Bonjour ! Comment puis-je vous aider ?"
        },
        {
            // user asks for infos — we give a proactive overview (no sector ask)
            regex: /en savoir plus|plus d['’ ]infos|informations sur vos solutions|quels sont vos services|parlez-moi de vos solutions/i,
            response: "Nous proposons : IA Téléphonique 24/7, IA Email (tri + réponses), IA Réseaux Sociaux et Chatbot Web. Quel sujet voulez-vous approfondir ?"
        },
        {
            // pricing
            regex: /\b(tarif|prix|coût|combien)/i,
            response: "Les tarifs dépendent de la taille et de la personnalisation. Quel est votre secteur ou volume d'appels ?"
        },
        {
            // rdv request (without email mention)
            regex: /\b(rendez-?vous|rdv|démo|demo|rencontrer)\b(?!.*@)/i,
            response: "Parfait pour une démo ! Quel est votre email pour vous envoyer le lien ?",
            action: 'rdv_request'
        },
        {
            // end of call
            regex: /^\s*(au revoir|bye|bonne journée|merci|merci beaucoup|c'est tout)\s*$/i,
            response: "Merci pour votre appel ! Un expert vous recontactera. Excellente journée ! FIN_APPEL"
        }
    ],
    check: function (text, profile) {
        // If profile has email and the input is only asking for "email" or similar, avoid redundant quick response
        if (profile && profile.email && /email|mail|adresse/i.test(text) && text.trim().length < 20) {
            return null;
        }
        for (const pattern of this.patterns) {
            if (pattern.regex.test(text)) {
                return pattern;
            }
        }
        return null;
    }
};

// ---------- ELEVENLABS AUDIO STREAM ENDPOINT ----------
app.get('/generate-audio/:token', async (req, res) => {
    const token = req.params.token;
    const text = global.audioQueue[token];

    if (!text) {
        return res.status(404).send('Audio not found');
    }

    if (!USE_ELEVENLABS || !ELEVENLABS_API_KEY) {
        // ElevenLabs disabled: respond 404 so Twilio fallback works
        delete global.audioQueue[token];
        return res.status(503).send('ElevenLabs disabled');
    }

    try {
        const startTime = Date.now();

        const voiceId = ELEVENLABS_VOICE_ID === '21m00Tcm4TlvDq8ikWAM'
            ? 'ThT5KcBeYPX3keUQqHPh'
            : ELEVENLABS_VOICE_ID;

        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            data: {
                text: text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.6,
                    similarity_boost: 0.8,
                    style: 0.0,
                    use_speaker_boost: false
                },
                optimize_streaming_latency: 4
            },
            responseType: 'stream',
            timeout: 20000
        });

        // Remove queued text immediately to avoid re-use
        delete global.audioQueue[token];

        res.set({
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Transfer-Encoding': 'chunked'
        });

        response.data.pipe(res);

        console.log(`✅ Audio streamé en ${Date.now() - startTime}ms`);
    } catch (error) {
        console.error('❌ Erreur ElevenLabs stream:', error.message);
        delete global.audioQueue[token];
        try {
            res.status(500).send('Error generating audio');
        } catch (e) {
            // ignore
        }
    }
});

// ---------- ROUTE VOICE (Twilio webhook) ----------
app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const from = req.body.From;

    console.log(`📞 APPEL: ${callSid} - ${from}`);

    // Init profile & conversation
    userProfiles.set(callSid, {
        phone: from,
        startTime: Date.now(),
        interactions: 0,
        email: null,
        sector: null,
        rdvRequested: false,
        rdvStage: 0 // 0 = none, 1 = email collected waiting for date, 2 = date collected
    });
    conversations.set(callSid, []);

    // Welcome message (ElevenLabs if enabled)
    const welcomeText = "Bonjour! Dynophone de Dynovate, comment puis-je vous aider?";
    if (USE_ELEVENLABS && ELEVENLABS_API_KEY) {
        try {
            const audioToken = Buffer.from(`welcome:${callSid}:${Date.now()}`).toString('base64url');
            global.audioQueue[audioToken] = welcomeText;
            twiml.play(`${BASE_URL}/generate-audio/${audioToken}`);
        } catch (e) {
            console.warn('Erreur génération welcome audio, fallback to Twilio voice:', e.message);
            twiml.say({ voice: 'alice', language: 'fr-FR' }, welcomeText);
        }
    } else {
        twiml.say({ voice: 'alice', language: 'fr-FR' }, welcomeText);
    }

    // Gather speech
    const gather = twiml.gather({
        input: 'speech',
        language: 'fr-FR',
        speechTimeout: 1,
        timeout: 5,
        action: '/process-speech',
        method: 'POST',
        speechModel: 'experimental_conversations',
        enhanced: true,
        profanityFilter: false
    });

    gather.say({ voice: 'alice', language: 'fr-FR' }, 'Je vous écoute.');

    twiml.redirect('/voice');

    res.type('text/xml');
    res.send(twiml.toString());
});

// ---------- PROCESS SPEECH ----------
app.post('/process-speech', async (req, res) => {
    const startTime = Date.now();
    const twiml = new twilio.twiml.VoiceResponse();
    const speechResult = (req.body.SpeechResult || '').trim();
    const callSid = req.body.CallSid;

    if (!speechResult) {
        return sendFallbackResponse(res, twiml, callSid);
    }

    console.log(`🎤 ${callSid}: "${speechResult}"`);

    // Ensure profile & conversation exist
    const profile = userProfiles.get(callSid) || {
        phone: req.body.From,
        startTime: Date.now(),
        interactions: 0,
        email: null,
        sector: null,
        rdvRequested: false,
        rdvStage: 0
    };
    userProfiles.set(callSid, profile);
    const conversation = conversations.get(callSid) || [];
    conversations.set(callSid, conversation);

    try {
        // 1) Email detection first (robust)
        const emailMatch = speechResult.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        if (emailMatch && !profile.email) {
            profile.email = emailMatch[1];
            profile.interactions = (profile.interactions || 0) + 1;
            profile.rdvStage = profile.rdvRequested ? 1 : 0; // if rdv requested earlier, now stage 1 (waiting date)
            userProfiles.set(callSid, profile);
            conversation.push({ role: 'user', content: speechResult });

            console.log(`📧 Email capturé: ${profile.email}`);

            // If RDV previously requested, send RDV email now (if email transporter available)
            if (profile.rdvRequested) {
                await sendRDVEmail(profile.email, profile.phone).catch(e => console.error('Erreur sendRDVEmail:', e.message));
                const responseText = "Parfait ! Je vous envoie le lien par email. À quelle période préférez-vous ?";
                conversation.push({ role: 'assistant', content: responseText });
                conversations.set(callSid, conversation);
                await sendVoiceResponse(res, twiml, responseText, callSid, false);
                return;
            } else {
                // Acknowledge email captured and continue
                const responseText = "Merci, j'ai bien votre email. Comment puis-je vous aider maintenant ?";
                conversation.push({ role: 'assistant', content: responseText });
                conversations.set(callSid, conversation);
                await sendVoiceResponse(res, twiml, responseText, callSid, false);
                return;
            }
        }

        // 2) Quick responses (with context)
        const quickMatch = QUICK_RESPONSES.check(speechResult, profile);
        if (quickMatch) {
            console.log(`⚡ Réponse rapide en ${Date.now() - startTime}ms`);
            // handle rdv_request
            if (quickMatch.action === 'rdv_request') {
                profile.rdvRequested = true;
                profile.rdvStage = profile.email ? 1 : 0;
                userProfiles.set(callSid, profile);

                // If email present, send RDV mail immediately
                if (profile.email) {
                    await sendRDVEmail(profile.email, profile.phone).catch(e => console.error('Erreur sendRDVEmail:', e.message));
                    const responseText = "Parfait, je vous ai envoyé le lien de réservation par email. À quelle période préférez-vous ?";
                    conversation.push({ role: 'assistant', content: responseText });
                    conversations.set(callSid, conversation);
                    await sendVoiceResponse(res, twiml, responseText, callSid, false);
                    return;
                } else {
                    // ask for email
                    const responseText = quickMatch.response;
                    conversation.push({ role: 'assistant', content: responseText });
                    conversations.set(callSid, conversation);
                    await sendVoiceResponse(res, twiml, responseText, callSid, false);
                    return;
                }
            }

            // handle FIN_APPEL cases in quick responses
            if (quickMatch.response.includes('FIN_APPEL')) {
                const cleanResponse = quickMatch.response.replace('FIN_APPEL', '').trim();
                conversation.push({ role: 'assistant', content: cleanResponse });
                conversations.set(callSid, conversation);
                await sendVoiceResponse(res, twiml, cleanResponse, callSid, true);
                return;
            }

            // generic quick response
            conversation.push({ role: 'assistant', content: quickMatch.response });
            conversations.set(callSid, conversation);
            await sendVoiceResponse(res, twiml, quickMatch.response, callSid, false);
            return;
        }

        // 3) Cache lookup
        const cacheKey = speechResult.toLowerCase().trim();
        if (responseCache.has(cacheKey)) {
            const cached = responseCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_DURATION) {
                console.log(`💾 Cache hit en ${Date.now() - startTime}ms`);
                conversation.push({ role: 'assistant', content: cached.response });
                conversations.set(callSid, conversation);
                await sendVoiceResponse(res, twiml, cached.response, callSid, false);
                return;
            }
        }

        // 4) Else: feed to LLM (streaming)
        // Add user message to conversation context
        conversation.push({ role: 'user', content: speechResult });
        userProfiles.set(callSid, profile);

        // RDV stage handling: if we are waiting for a date/time and user says a date/time, capture it ASAP without calling LLM
        if (profile.rdvRequested && profile.rdvStage === 1) {
            // Simple date/time detection (common patterns: demain, aujourd'hui, horaire like 13h, 'le 25 septembre', 'à 14h30')
            const dateTimeRegex = /\b(demain|aujourd'hui|mercredi|mardi|lundi|jeudi|vendredi|samedi|dimanche|le\s+\d{1,2}\s+\w+|\b\d{1,2}h\d{0,2}\b|\b\d{1,2}h\b)\b/i;
            if (dateTimeRegex.test(speechResult)) {
                profile.rdvStage = 2; // date collected
                userProfiles.set(callSid, profile);

                // compose final confirmation & send RDV mail
                const chosenSlot = speechResult;
                const confirmation = `Parfait, je note votre disponibilité : ${chosenSlot}. Je vous envoie la confirmation par email. FIN_APPEL`;
                // send rdv email if possible
                if (profile.email) {
                    await sendRDVEmail(profile.email, profile.phone).catch(e => console.error('Erreur sendRDVEmail:', e.message));
                }
                conversation.push({ role: 'assistant', content: confirmation });
                conversations.set(callSid, conversation);
                await sendVoiceResponse(res, twiml, confirmation, callSid, true);
                return;
            }
            // if not matched, fall through to LLM for help to interpret
        }

        // If no special RDV stage, call Groq
        let aiResponse = "";
        let responseComplete = false;

        // Timeout fallback after 2s
        const groqTimeout = setTimeout(() => {
            if (!responseComplete) {
                aiResponse = "Je réfléchis à votre question. Pouvez-vous préciser votre besoin ?";
                responseComplete = true;
            }
        }, 2000);

        try {
            const stream = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: DYNOVATE_CONTEXT },
                    ...conversation.slice(-6)
                ],
                temperature: 0.3,
                max_tokens: 120,
                stream: true,
                top_p: 0.9
            });

            // Collect stream chunks
            for await (const chunk of stream) {
                if (responseComplete) break;
                const delta = chunk.choices?.[0]?.delta;
                const content = delta?.content || '';
                aiResponse += content;
                // Optionally: if aiResponse long enough, we could stream to TTS earlier; for now we collect
            }

            clearTimeout(groqTimeout);
            responseComplete = true;

        } catch (groqError) {
            clearTimeout(groqTimeout);
            console.error(`⚠️ Erreur Groq: ${groqError.message}`);
            if (!aiResponse) {
                aiResponse = "Nos solutions d'IA améliorent votre relation client. Quel est votre secteur ?";
            }
        }

        aiResponse = aiResponse.trim();

        // If user already has an email, avoid AI asking for email again — adjust only if AI asks for "email" explicitly
        if (profile.email && /email/i.test(aiResponse)) {
            // Only remove the explicit email ask if AI suggests collecting it — provide alternative phrasing
            aiResponse = aiResponse.replace(/(quel(?:le|)s?\s+est\s+votre\s+email[:?]?)/i, 'Parfait ! Quelle période vous conviendrait pour une démo ?');
            // If the replacement created an odd sentence, fallback to a simple question
            if (!aiResponse || aiResponse.length < 5) {
                aiResponse = "Parfait ! Quelle période vous conviendrait pour une démo ?";
            }
        }

        // Save to cache & conversation
        responseCache.set(cacheKey, { response: aiResponse, timestamp: Date.now() });
        conversation.push({ role: 'assistant', content: aiResponse });
        conversations.set(callSid, conversation);

        // extract user info heuristically
        extractUserInfo(callSid, speechResult, aiResponse);

        const shouldEndCall = /FIN_APPEL/.test(aiResponse);
        if (shouldEndCall) {
            // strip token
            aiResponse = aiResponse.replace(/FIN_APPEL/g, '').trim();
        }

        console.log(`⚡ ${callSid} [GROQ] (${Date.now() - startTime}ms): "${aiResponse}"`);
        delete global.streamingResponses[callSid];

        await sendVoiceResponse(res, twiml, aiResponse, callSid, shouldEndCall);
    } catch (error) {
        console.error(`❌ Erreur ${callSid}:`, error);
        return sendFallbackResponse(res, twiml, callSid);
    }
});

// ---------- sendVoiceResponse (ElevenLabs or Twilio fallback) ----------
async function sendVoiceResponse(res, twiml, text, callSid, shouldEndCall) {
    const startTime = Date.now();

    // Make sure text is not empty
    const message = (text || '').trim() || "Désolé, je n'ai pas compris. Pouvez-vous répéter ?";

    if (USE_ELEVENLABS && ELEVENLABS_API_KEY) {
        try {
            const audioToken = Buffer.from(`${callSid}:${Date.now()}:${Math.random()}`).toString('base64url');
            global.audioQueue[audioToken] = message;

            // Play from our /generate-audio endpoint
            twiml.play(`${BASE_URL}/generate-audio/${audioToken}`);
            console.log('🎵 Audio ElevenLabs configuré');
        } catch (error) {
            console.error('❌ Erreur en configurant ElevenLabs TTS:', error.message);
            // fallback to Twilio voice
            twiml.say({ voice: 'alice', language: 'fr-FR' }, message);
        }
    } else {
        // Twilio TTS fallback
        twiml.say({ voice: 'alice', language: 'fr-FR' }, message);
        console.log('🔊 Voix Alice (ElevenLabs désactivé)');
    }

    if (shouldEndCall) {
        console.log(`🏁 Fin d'appel: ${callSid}`);
        twiml.pause({ length: 1 });
        twiml.hangup();
        // send summary shortly after hangup
        setTimeout(() => cleanupCall(callSid), 150);
    } else {
        // Prepare next gather
        const profile = userProfiles.get(callSid) || {};
        const timeoutDuration = (profile.interactions || 0) > 3 ? 2 : 4;

        const gather = twiml.gather({
            input: 'speech',
            language: 'fr-FR',
            speechTimeout: 1,
            timeout: timeoutDuration,
            action: '/process-speech',
            method: 'POST',
            speechModel: 'experimental_conversations',
            enhanced: true,
            profanityFilter: false
        });

        gather.say({ voice: 'alice', language: 'fr-FR' }, 'Je vous écoute.');
        // Add short closing line (won't be read before gather prompt)
        twiml.say({ voice: 'alice', language: 'fr-FR' }, 'Merci pour votre appel. Un expert vous recontactera!');
        // Do not hangup here; Twilio will wait for next gather / redirect
    }

    console.log(`⏱️ Réponse en ${Date.now() - startTime}ms`);
    res.type('text/xml');
    res.send(twiml.toString());
}

// ---------- sendRDVEmail ----------
async function sendRDVEmail(email, phone) {
    if (!emailTransporter) {
        console.log('❌ Email non configuré pour envoi RDV');
        return;
    }

    const calendlyLink = process.env.CALENDLY_LINK || 'https://calendly.com/dynovate/demo';

    try {
        const emailContent = `
Bonjour,

Suite à notre conversation téléphonique, voici le lien pour réserver votre démonstration gratuite Dynovate :

🗓️ Réservez votre créneau : ${calendlyLink}

Nos solutions d'IA pour entreprises :
• IA Téléphonique : Gestion d'appels 24h/7j (comme notre conversation)
• IA Email : Classification et réponses automatiques
• IA Réseaux Sociaux : Réponses instantanées sur tous vos canaux
• Chatbot Web : Assistant intelligent pour votre site

Choisissez le créneau qui vous convient le mieux et nous vous montrerons comment l'IA peut transformer votre relation client.

À très bientôt !

L'équipe Dynovate
📞 Contact : ${phone}
        `;

        await emailTransporter.sendMail({
            from: `"Dynovate" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: '🗓️ Votre lien de réservation Dynovate',
            text: emailContent,
            html: emailContent.replace(/\n/g, '<br>')
        });

        console.log(`📧 Email RDV envoyé à ${email}`);
    } catch (error) {
        console.error(`❌ Erreur envoi email RDV: ${error.message}`);
    }
}

// ---------- sendCallSummary (report) ----------
async function sendCallSummary(profile, conversation) {
    if (!profile) return;

    if (!emailTransporter) {
        console.log('📧 Email non configuré - Sauvegarde locale du résumé');
        const summary = generateLocalSummary(profile, conversation);
        console.log('📊 COMPTE RENDU:', JSON.stringify(summary, null, 2));
        // Save locally
        try {
            const fileName = `call_${profile.phone}_${Date.now()}.json`;
            await fs.writeFile(path.join(__dirname, 'reports', fileName), JSON.stringify(summary, null, 2));
            console.log(`📁 Rapport sauvegardé: ./reports/${fileName}`);
        } catch (e) {
            console.error('Impossible de sauvegarder le fichier:', e.message);
        }
        return;
    }

    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    let summaryText = "Résumé non disponible";

    try {
        const summaryPrompt = [
            {
                role: "system",
                content: "Résume cet appel commercial en 5 points maximum. Identifie: besoins client, solutions proposées, prochaines étapes."
            },
            ...conversation
        ];

        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: summaryPrompt,
            max_tokens: 150,
            temperature: 0.3
        });

        summaryText = completion.choices[0].message.content.trim();
    } catch (e) {
        console.error("Erreur résumé:", e.message);
    }

    // If RDV requested & email collected, send RDV email
    let nextSteps = "";
    if (profile.rdvRequested && profile.email) {
        await sendRDVEmail(profile.email, profile.phone).catch(e => console.error('Erreur sendRDVEmail:', e.message));
        nextSteps = "• Lien de réservation envoyé par email\n";
    }

    const emailContent = `
📞 COMPTE RENDU D'APPEL DYNOVATE

📱 Téléphone: ${profile.phone}
📧 Email: ${profile.email || 'Non collecté'}
🏢 Secteur: ${profile.sector || 'Non identifié'}
⏱️ Durée: ${duration} secondes
💬 Interactions: ${profile.interactions || 0}
📅 Date: ${new Date().toLocaleString('fr-FR')}

📝 RÉSUMÉ:
${summaryText}

PROCHAINES ACTIONS:
${nextSteps}${profile.email ? '• Envoyer documentation personnalisée\n• Programmer suivi J+2' : '• Recontacter pour obtenir email\n• Qualifier le besoin'}
`;

    try {
        await emailTransporter.sendMail({
            from: `"Dynophone" <${process.env.EMAIL_USER}>`,
            to: process.env.REPORT_EMAIL || process.env.EMAIL_USER,
            cc: profile.email && profile.rdvRequested ? profile.email : undefined,
            subject: `[${profile.email ? 'LEAD CHAUD' : 'À QUALIFIER'}] ${profile.phone} - ${profile.sector || 'Nouveau contact'}`,
            text: emailContent,
            priority: profile.email && profile.rdvRequested ? 'high' : 'normal'
        });

        console.log(`📧 Compte rendu envoyé (${profile.email ? 'LEAD QUALIFIÉ' : 'À SUIVRE'})`);
    } catch (error) {
        console.error(`❌ Erreur envoi compte rendu: ${error.message}`);
    }
}

// ---------- Local summary generator ----------
function generateLocalSummary(profile, conversation) {
    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    return {
        timestamp: new Date().toISOString(),
        phone: profile.phone,
        email: profile.email || null,
        sector: profile.sector || null,
        duration: `${duration}s`,
        interactions: profile.interactions,
        qualified: !!(profile.email || profile.sector),
        conversation: conversation.map(msg => ({ role: msg.role, content: msg.content }))
    };
}

// ---------- extractUserInfo (heuristics) ----------
function extractUserInfo(callSid, speech, response) {
    const profile = userProfiles.get(callSid) || {};
    const lower = (speech || '').toLowerCase();

    // Email detection
    const emailMatch = speech.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch && !profile.email) {
        profile.email = emailMatch[1];
        console.log(`📧 Email: ${profile.email}`);
    }

    // sector keywords
    const sectors = [
        { keywords: ['restaurant', 'café', 'bar', 'hôtel'], name: 'Restauration' },
        { keywords: ['immobilier', 'agence', 'location'], name: 'Immobilier' },
        { keywords: ['commerce', 'boutique', 'magasin'], name: 'Commerce' },
        { keywords: ['médical', 'médecin', 'cabinet', 'santé'], name: 'Santé' },
        { keywords: ['garage', 'automobile', 'voiture'], name: 'Automobile' }
    ];

    for (const s of sectors) {
        if (!profile.sector && s.keywords.some(k => lower.includes(k))) {
            profile.sector = s.name;
            console.log(`🏷️ Secteur détecté: ${profile.sector}`);
            break;
        }
    }

    // RDV detection
    if (!profile.rdvRequested && /\b(rendez-?vous|rdv|démo|demo|rencontrer)\b/i.test(speech)) {
        profile.rdvRequested = true;
        // if email already present, set rdvStage to 1, else 0
        profile.rdvStage = profile.email ? 1 : 0;
    }

    userProfiles.set(callSid, profile);
}

// ---------- cleanupCall ----------
async function cleanupCall(callSid) {
    const profile = userProfiles.get(callSid);
    const conversation = conversations.get(callSid) || [];
    if (!profile) return;

    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    console.log(`📊 Fin appel - ${duration}s, ${profile.interactions || 0} échanges`);

    try {
        await sendCallSummary(profile, conversation);
    } catch (e) {
        console.error('Erreur envoi compte rendu dans cleanupCall:', e.message);
    }

    conversations.delete(callSid);
    userProfiles.delete(callSid);
}

// ---------- fallback gather ----------
function sendFallbackResponse(res, twiml, callSid) {
    console.log(`🚨 Fallback: ${callSid}`);
    twiml.say({ voice: 'alice', language: 'fr-FR' }, 'Un instant.');
    const gather = twiml.gather({
        input: 'speech',
        language: 'fr-FR',
        speechTimeout: 1,
        timeout: 3,
        action: '/process-speech',
        method: 'POST'
    });
    res.type('text/xml');
    res.send(twiml.toString());
}

// ---------- health ----------
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        features: {
            elevenlabs: !!(USE_ELEVENLABS && ELEVENLABS_API_KEY),
            email: !!emailTransporter,
            sms: !!twilioClient,
            streaming: true
        },
        stats: {
            activeConversations: conversations.size,
            cacheSize: responseCache.size
        }
    });
});

// ---------- periodic cleanup ----------
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30min
    for (const [callSid, profile] of userProfiles.entries()) {
        if (now - profile.startTime > maxAge) {
            cleanupCall(callSid);
        }
    }
    if (Object.keys(global.audioQueue).length > 200) {
        global.audioQueue = {};
    }
}, 10 * 60 * 1000);

// ---------- START SERVER ----------
app.listen(PORT, () => {
    console.log(`
    🚀 Dynovate Assistant IA - VERSION OPTIMISÉE
    ⚡ Port: ${PORT}

    ✅ FONCTIONNALITÉS ACTIVES:
    ${USE_ELEVENLABS ? '🎵 ElevenLabs TTS activé' : '🔇 ElevenLabs désactivé (USE_ELEVENLABS=false)'}
    ${emailTransporter ? '📧 Comptes rendus + liens RDV par email' : '❌ Email (ajouter EMAIL_USER et EMAIL_PASS)'}
    🚀 Streaming Groq activé
    💾 Cache intelligent activé
    ⚡ Timeout 2s avec fallback
    📅 Prise de RDV par email

    💡 Pour désactiver ElevenLabs: USE_ELEVENLABS=false
    💡 Pour activer ElevenLabs: USE_ELEVENLABS=true
    `);

    // Optional ElevenLabs usage reporting
    if (USE_ELEVENLABS && ELEVENLABS_API_KEY) {
        axios.get('https://api.elevenlabs.io/v1/user', {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY }
        }).then(response => {
            console.log(`    💳 ElevenLabs: ${response.data.subscription?.character_count || '?'} / ${response.data.subscription?.character_limit || '?'} caractères`);
        }).catch(() => { /* ignore */ });
    }
});
