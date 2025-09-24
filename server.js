const express = require('express');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();

// Configuration
const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY || 'gsk_dummy_key_for_init'
});

// FLAG pour activer/désactiver ElevenLabs facilement
const USE_ELEVENLABS = process.env.USE_ELEVENLABS === 'true';
const ELEVENLABS_API_KEY = USE_ELEVENLABS ? process.env.ELEVENLABS_API_KEY : null;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'ThT5KcBeYPX3keUQqHPh';

// Configuration email uniquement (pas de SMS)
let emailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
        emailTransporter = nodemailer.createTransporter({
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
}

// Stockage global
global.audioQueue = {};
global.streamingResponses = {};

// Stockage conversations
const conversations = new Map();
const userProfiles = new Map();
const responseCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Middleware
app.use(express.urlencoded({ extended: false }));

// Contexte Dynovate optimisé (sans SMS)
const DYNOVATE_CONTEXT = `Tu es Dynophone, expert commercial chez Dynovate spécialisée en IA pour la relation client.

DYNOVATE - SOLUTIONS IA:
1. IA Réseaux Sociaux: Automatise les réponses 24h/7j
2. IA Email: Classe/répond/relance automatiquement
3. IA Téléphonique: Comme moi, disponible 24h/7j
4. IA Chatbot Web: Guide visiteurs

OBJECTIFS:
- Qualifier besoins (secteur, problématiques)
- Collecter EMAIL obligatoirement pour suivi
- Pour RDV: TOUJOURS demander l'email d'abord, puis dire "Je vous envoie le lien de réservation par email"

RÈGLES:
- Réponses TRÈS COURTES: 15 mots maximum
- Une question à la fois
- Si demande RDV sans email: "Pour vous envoyer le lien, quel est votre email ?"
- Détecter fin: "merci", "au revoir" → ajoute "FIN_APPEL"

Sois rapide, précis, efficace.`;

// Réponses rapides STRICTES (match exact pour éviter les doublons)
const QUICK_RESPONSES = {
    patterns: [
        {
            regex: /^bonjour$/i,  // EXACT match uniquement
            response: "Bonjour ! Dynophone de Dynovate. Comment puis-je vous aider ?"
        },
        {
            regex: /^salut$/i,  // EXACT match
            response: "Bonjour ! Comment puis-je vous aider ?"
        },
        {
            regex: /tarif|prix|coût|combien.*coût/i,  // Plus flexible pour prix
            response: "Les tarifs dépendent de vos besoins. Quel est votre secteur ?"
        },
        {
            regex: /rendez-vous|rdv|démo(?!.*email)/i,  // RDV sans mention d'email
            response: "Parfait pour une démo ! Quel est votre email pour vous envoyer le lien ?",
            action: 'rdv_request'
        },
        {
            regex: /^au revoir$|^bye$|^bonne journée$/i,  // Match exact
            response: "Merci pour votre appel ! Un expert vous recontactera. Excellente journée ! FIN_APPEL"
        }
    ],
    
    check: function(text, profile) {
        // NE PAS redemander l'email si on l'a déjà
        if (profile && profile.email && text.toLowerCase().includes('email')) {
            return null; // Pas de réponse rapide si on a déjà l'email
        }
        
        for (const pattern of this.patterns) {
            if (pattern.regex.test(text)) {
                return pattern;
            }
        }
        return null;
    }
};

// ENDPOINT AUDIO ELEVENLABS STREAMING
app.get('/generate-audio/:token', async (req, res) => {
    const token = req.params.token;
    const text = global.audioQueue[token];
    
    if (!text) {
        return res.status(404).send('Audio not found');
    }
    
    if (!ELEVENLABS_API_KEY) {
        return res.status(500).send('ElevenLabs not configured');
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
                optimize_streaming_latency: 4 // Maximum optimization
            },
            responseType: 'stream'
        });
        
        delete global.audioQueue[token];
        
        res.set({
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Transfer-Encoding': 'chunked'
        });
        
        response.data.pipe(res);
        
        console.log(`✅ Audio streamé en ${Date.now() - startTime}ms`);
        
    } catch (error) {
        console.error(`❌ Erreur: ${error.message}`);
        delete global.audioQueue[token];
        res.status(500).send('Error');
    }
});

// Route principale
app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    
    console.log(`📞 APPEL: ${callSid} - ${req.body.From}`);
    
    userProfiles.set(callSid, {
        phone: req.body.From,
        startTime: Date.now(),
        interactions: 0
    });
    conversations.set(callSid, []);
    
    // Message d'accueil avec ElevenLabs
    if (ELEVENLABS_API_KEY) {
        try {
            const welcomeText = "Bonjour! Dynophone de Dynovate, comment puis-je vous aider?";
            const audioToken = Buffer.from(`welcome:${callSid}:${Date.now()}`).toString('base64url');
            
            global.audioQueue[audioToken] = welcomeText;
            
            const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : `https://${req.headers.host}`;
            
            twiml.play(`${baseUrl}/generate-audio/${audioToken}`);
            
        } catch (error) {
            twiml.say({ voice: 'alice', language: 'fr-FR' }, 
                'Bonjour! Dynophone de Dynovate, comment puis-je vous aider?');
        }
    } else {
        twiml.say({ voice: 'alice', language: 'fr-FR' }, 
            'Bonjour! Dynophone de Dynovate, comment puis-je vous aider?');
    }
    
    const gather = twiml.gather({
        input: 'speech',
        language: 'fr-FR',
        speechTimeout: 1,
        timeout: 4, // Plus court
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

// Traitement speech CORRIGÉ - Pas de doublons
app.post('/process-speech', async (req, res) => {
    const startTime = Date.now();
    const twiml = new twilio.twiml.VoiceResponse();
    const speechResult = req.body.SpeechResult || '';
    const callSid = req.body.CallSid;
    
    if (!speechResult.trim()) {
        return sendFallbackResponse(res, twiml, callSid);
    }
    
    console.log(`🎤 ${callSid}: "${speechResult}"`);
    
    // Récupérer le profil pour éviter les doublons
    const userProfile = userProfiles.get(callSid) || {};
    
    try {
        // DÉTECTION EMAIL EN PREMIER
        const emailMatch = speechResult.match(/[\w.-]+@[\w.-]+\.\w+/);
        if (emailMatch && !userProfile.email) {
            userProfile.email = emailMatch[0];
            console.log(`📧 Email capturé: ${userProfile.email}`);
            userProfiles.set(callSid, userProfile);
            
            // Si RDV était demandé, envoyer le lien
            if (userProfile.rdvRequested) {
                await sendRDVEmail(userProfile.email, userProfile.phone);
                const response = "Parfait ! Je vous envoie le lien par email. À quelle période préférez-vous ?";
                await sendVoiceResponse(res, twiml, response, callSid, false);
                return;
            }
        }
        
        // CHECK RÉPONSES RAPIDES avec contexte profil
        const quickMatch = QUICK_RESPONSES.check(speechResult, userProfile);
        if (quickMatch) {
            console.log(`⚡ Réponse rapide en ${Date.now() - startTime}ms`);
            
            // Actions spéciales
            if (quickMatch.action === 'rdv_request') {
                userProfile.rdvRequested = true;
                userProfiles.set(callSid, userProfile);
                
                // Si on a déjà l'email, pas besoin de le redemander
                if (userProfile.email) {
                    await sendRDVEmail(userProfile.email, userProfile.phone);
                    const response = "Je vous envoie le lien de réservation. À quelle période ?";
                    await sendVoiceResponse(res, twiml, response, callSid, false);
                    return;
                }
            }
            
            if (quickMatch.response.includes('FIN_APPEL')) {
                const cleanResponse = quickMatch.response.replace('FIN_APPEL', '');
                await sendVoiceResponse(res, twiml, cleanResponse, callSid, true);
            } else {
                await sendVoiceResponse(res, twiml, quickMatch.response, callSid, false);
            }
            return;
        }
        
        // CHECK CACHE
        const cacheKey = speechResult.toLowerCase().trim();
        if (responseCache.has(cacheKey)) {
            const cached = responseCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_DURATION) {
                console.log(`💾 Cache hit en ${Date.now() - startTime}ms`);
                await sendVoiceResponse(res, twiml, cached.response, callSid, false);
                return;
            }
        }
        
        // PRÉPARER CONVERSATION
        const conversation = conversations.get(callSid) || [];
        
        userProfile.interactions = (userProfile.interactions || 0) + 1;
        userProfiles.set(callSid, userProfile);
        
        conversation.push({ role: 'user', content: speechResult });
        
        // GROQ AVEC STREAMING ET TIMEOUT
        let aiResponse = "";
        let responseComplete = false;
        
        const groqTimeout = setTimeout(() => {
            if (!responseComplete) {
                aiResponse = "Je réfléchis. Pouvez-vous préciser votre besoin ?";
                responseComplete = true;
            }
        }, 2000);
        
        try {
            const stream = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: DYNOVATE_CONTEXT },
                    ...conversation.slice(-4)
                ],
                temperature: 0.3,
                max_tokens: 40,
                stream: true,
                top_p: 0.9
            });
            
            for await (const chunk of stream) {
                if (responseComplete) break;
                const content = chunk.choices[0]?.delta?.content || '';
                aiResponse += content;
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
        
        // NE PAS redemander l'email si on l'a déjà
        if (userProfile.email && aiResponse.toLowerCase().includes('email')) {
            aiResponse = "Parfait ! Quelle période vous conviendrait pour une démo ?";
        }
        
        responseCache.set(cacheKey, {
            response: aiResponse,
            timestamp: Date.now()
        });
        
        const shouldEndCall = aiResponse.includes('FIN_APPEL');
        if (shouldEndCall) {
            aiResponse = aiResponse.replace('FIN_APPEL', '').trim();
        }
        
        conversation.push({ role: 'assistant', content: aiResponse });
        conversations.set(callSid, conversation);
        
        extractUserInfo(callSid, speechResult, aiResponse);
        
        console.log(`⚡ ${callSid} [GROQ] (${Date.now() - startTime}ms): "${aiResponse}"`);
        
        delete global.streamingResponses[callSid];
        
        await sendVoiceResponse(res, twiml, aiResponse, callSid, shouldEndCall);
        
    } catch (error) {
        console.error(`❌ Erreur ${callSid}:`, error);
        return sendFallbackResponse(res, twiml, callSid);
    }
});

// Réponse vocale optimisée (avec flag ElevenLabs)
async function sendVoiceResponse(res, twiml, text, callSid, shouldEndCall) {
    const startTime = Date.now();
    
    if (USE_ELEVENLABS && ELEVENLABS_API_KEY) {
        try {
            const audioToken = Buffer.from(`${callSid}:${Date.now()}:${Math.random()}`).toString('base64url');
            global.audioQueue[audioToken] = text;
            
            const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : `https://${req.headers.host || 'localhost:3000'}`;
            
            twiml.play(`${baseUrl}/generate-audio/${audioToken}`);
            console.log('🎵 Audio ElevenLabs configuré');
            
        } catch (error) {
            console.error(`❌ Erreur: ${error.message}`);
            twiml.say({ voice: 'alice', language: 'fr-FR' }, text);
        }
    } else {
        // Utiliser voix Alice si ElevenLabs désactivé
        twiml.say({ voice: 'alice', language: 'fr-FR' }, text);
        console.log('🔊 Voix Alice (ElevenLabs désactivé)');
    }
    
    if (shouldEndCall) {
        console.log(`🏁 Fin d'appel: ${callSid}`);
        twiml.pause({ length: 1 });
        twiml.hangup();
        setTimeout(() => cleanupCall(callSid), 100);
    } else {
        const profile = userProfiles.get(callSid) || {};
        const timeoutDuration = profile.interactions > 3 ? 2 : 4;
        
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
        
        twiml.say({ voice: 'alice', language: 'fr-FR' }, 
            'Merci pour votre appel. Un expert vous recontactera!');
        
        twiml.hangup();
    }
    
    console.log(`⏱️ Réponse en ${Date.now() - startTime}ms`);
    res.type('text/xml');
    res.send(twiml.toString());
}

// Envoi email pour RDV (remplace SMS)
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

// Compte rendu d'appel par email (amélioré)
async function sendCallSummary(profile, conversation) {
    if (!emailTransporter) {
        console.log('📧 Email non configuré - Sauvegarde locale du résumé');
        const summary = generateLocalSummary(profile, conversation);
        console.log('📊 COMPTE RENDU:', JSON.stringify(summary, null, 2));
        
        // Sauvegarder dans un fichier si nécessaire
        const fs = require('fs').promises;
        const fileName = `call_${profile.phone}_${Date.now()}.json`;
        try {
            await fs.writeFile(`./reports/${fileName}`, JSON.stringify(summary, null, 2));
            console.log(`📁 Rapport sauvegardé: ./reports/${fileName}`);
        } catch (e) {
            console.log('Impossible de sauvegarder le fichier');
        }
        return;
    }
    
    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    
    // Générer résumé avec Groq
    let summary = "Résumé non disponible";
    let nextSteps = "";
    
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
        
        summary = completion.choices[0].message.content.trim();
    } catch (e) {
        console.error("Erreur résumé:", e.message);
    }
    
    // Si RDV demandé et email collecté, envoyer le lien
    if (profile.rdvRequested && profile.email) {
        await sendRDVEmail(profile.email, profile.phone);
        nextSteps = "• Lien de réservation envoyé par email\n";
    }
    
    // Créer le compte rendu structuré
    const emailContent = `
📞 COMPTE RENDU D'APPEL DYNOVATE

━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 INFORMATIONS DE CONTACT
━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 Téléphone: ${profile.phone}
📧 Email: ${profile.email || '⚠️ Non collecté'}
🏢 Secteur: ${profile.sector || '⚠️ Non identifié'}
⏱️ Durée: ${duration} secondes
💬 Interactions: ${profile.interactions || 0}
📅 Date: ${new Date().toLocaleString('fr-FR')}

━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 RÉSUMÉ DE LA CONVERSATION
━━━━━━━━━━━━━━━━━━━━━━━━━━

${summary}

━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 QUALIFICATION DU LEAD
━━━━━━━━━━━━━━━━━━━━━━━━━━

${profile.email ? '✅ Lead qualifié (email collecté)' : '❌ Email à collecter'}
${profile.sector ? '✅ Secteur identifié' : '❌ Secteur à préciser'}
${profile.rdvRequested ? '✅ Intérêt pour une démo' : '⚠️ Intérêt à confirmer'}

Score de qualification: ${
    (profile.email ? 40 : 0) + 
    (profile.sector ? 30 : 0) + 
    (profile.rdvRequested ? 30 : 0)
}%

━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 PROCHAINES ACTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━

${nextSteps}${profile.email 
    ? '• Envoyer documentation personnalisée\n• Programmer suivi J+2' 
    : '• Recontacter pour obtenir email\n• Qualifier le besoin'}
${profile.rdvRequested && !profile.email 
    ? '\n• ⚠️ RDV demandé mais email manquant - Rappeler' 
    : ''}
${!profile.rdvRequested 
    ? '\n• Proposer une démonstration lors du prochain contact' 
    : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 TRANSCRIPTION COMPLÈTE
━━━━━━━━━━━━━━━━━━━━━━━━━━

${conversation.map(msg => 
    `${msg.role === 'user' ? '👤 Client' : '🤖 Dynovate'}: ${msg.content}`
).join('\n\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━
Généré automatiquement par Dynovate Assistant IA
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

// Génération résumé local (fallback)
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
        conversation: conversation.map(msg => ({
            role: msg.role,
            content: msg.content
        }))
    };
}

// Extraction infos améliorée
function extractUserInfo(callSid, speech, response) {
    const profile = userProfiles.get(callSid) || {};
    const lowerSpeech = speech.toLowerCase();
    
    // Email
    const emailMatch = speech.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (emailMatch) {
        profile.email = emailMatch[0];
        console.log(`📧 Email: ${profile.email}`);
    }
    
    // Secteur
    const sectors = [
        { keywords: ['restaurant', 'café', 'bar', 'hôtel'], name: 'Restauration' },
        { keywords: ['immobilier', 'agence', 'location'], name: 'Immobilier' },
        { keywords: ['commerce', 'boutique', 'magasin'], name: 'Commerce' },
        { keywords: ['médical', 'médecin', 'cabinet', 'santé'], name: 'Santé' },
        { keywords: ['garage', 'automobile', 'voiture'], name: 'Automobile' }
    ];
    
    for (const sector of sectors) {
        if (sector.keywords.some(keyword => lowerSpeech.includes(keyword))) {
            profile.sector = sector.name;
            break;
        }
    }
    
    // Détection demande RDV
    if (/rendez-vous|rdv|démo|rencontrer/i.test(lowerSpeech)) {
        profile.rdvRequested = true;
    }
    
    userProfiles.set(callSid, profile);
}

// Nettoyage avec compte rendu
async function cleanupCall(callSid) {
    const profile = userProfiles.get(callSid);
    const conversation = conversations.get(callSid) || [];
    
    if (profile) {
        const duration = Math.round((Date.now() - profile.startTime) / 1000);
        console.log(`📊 Fin appel - ${duration}s, ${profile.interactions} échanges`);
        
        // Envoyer le compte rendu
        await sendCallSummary(profile, conversation);
        
        if (profile.email || profile.sector) {
            console.log(`💰 LEAD QUALIFIÉ: ${profile.email || 'N/A'} - ${profile.sector || 'N/A'}`);
        }
    }
    
    conversations.delete(callSid);
    userProfiles.delete(callSid);
}

// Fallback
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

// Endpoints API
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK',
        features: {
            elevenlabs: !!ELEVENLABS_API_KEY,
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

// Nettoyage périodique
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;
    
    for (const [callSid, profile] of userProfiles.entries()) {
        if (now - profile.startTime > maxAge) {
            cleanupCall(callSid);
        }
    }
    
    if (Object.keys(global.audioQueue).length > 100) {
        global.audioQueue = {};
    }
}, 10 * 60 * 1000);

// Démarrage
const PORT = process.env.PORT || 3000;
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
    
    📊 OPTIMISATIONS:
    - Réponses rapides enrichies
    - Streaming LLM → TTS
    - Cache étendu (10 min)
    - Timeouts réduits
    - Comptes rendus automatiques
    `);
    
    if (ELEVENLABS_API_KEY) {
        axios.get('https://api.elevenlabs.io/v1/user', {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY }
        }).then(response => {
            console.log(`    💳 ElevenLabs: ${response.data.subscription.character_count}/${response.data.subscription.character_limit} caractères`);
        }).catch(() => {});
    }
});