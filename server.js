const express = require('express');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();

// Configuration optimisée
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;

// Voix standard Twilio en fallback
const FALLBACK_VOICE = {
    voice: 'alice',
    language: 'fr-FR'
};

// Stockage conversations en mémoire
const conversations = new Map();
const userProfiles = new Map();

// Cache de réponses pour latence minimale
const responseCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Middleware
app.use(express.urlencoded({ extended: false }));

// Contexte Dynovate EXACT
const DYNOVATE_CONTEXT = `Tu es Dynophone, expert commercial chez Dynovate spécialisée en IA pour la relation client.

DYNOVATE - SOLUTIONS IA:
1. IA Réseaux Sociaux: Automatise les réponses aux clients sur Instagram/Facebook/LinkedIn 24h/7j
2. IA Email: Classe/répond/relance automatiquement, intégration complète
3. IA Téléphonique: Accueil/RDV/qualification comme moi, disponible 24h/7j
4. IA Chatbot Web: Guide visiteurs

TARIFS & PROCESS:
- Tarifs dépendent de la complexité de la solution et de la personnalisation souhaité
- Enterprise sur mesure
- Démo gratuite: Lundi/Dimanche 8h-20h

OBJECTIFS COMMERCIAUX:
1. Qualifier besoins (secteur, problématiques)
2. Collecter email pour suivi
3. Proposer audit gratuit ou démo
4. Clôturer positivement

RÈGLES CONVERSATION:
- Sois chaleureux, professionnel, commercial français expert
- Réponses courtes: 1-2 phrases maximum
- Questions engageantes pour maintenir dialogue
- Détecte signaux de fin: "merci", "ça suffit", "non merci", "au revoir", répétitions

GESTION FIN D'APPEL - TRÈS IMPORTANT:
Si client dit: "merci", "non merci", "ça suffit", "au revoir", "c'est bon" ou répète 3x la même question sans engagement:
→ Termine poliment: "Merci pour votre temps ! N'hésitez pas à nous rappeler. Un expert vous recontactera si vous le souhaitez. Excellente journée !"
→ Ajoute "FIN_APPEL" à la fin de ta réponse pour signaler la fin

N'invente rien que tu ne sais pas sur des faux exemples

Sois un vrai commercial qui sait quand s'arrêter et clôturer proprement !`;

// Réponses rapides pré-définies (instantanées)
const QUICK_RESPONSES = {
    patterns: [
        {
            regex: /bonjour|hello|salut|bonsoir/i,
            response: "Bonjour ! Dynophone de chez Dynovate, spécialiste IA relation client. Comment puis-je vous aider ?"
        },
        {
            regex: /prix|tarif|coût|combien/i,
            response: "Les tarifs dépendent de la complexité et personnalisation souhaitées. Quel est votre secteur d'activité ?"
        },
        {
            regex: /au revoir|bye|bonne journée|à bientôt/i,
            response: "Merci pour votre temps ! N'hésitez pas à nous rappeler. Un expert vous recontactera si vous le souhaitez. Excellente journée ! FIN_APPEL"
        },
        {
            regex: /merci|non merci|ça suffit|c'est bon/i,
            response: "Merci pour votre temps ! N'hésitez pas à nous rappeler. Un expert vous recontactera si vous le souhaitez. Excellente journée ! FIN_APPEL"
        },
        {
            regex: /rendez-vous|rdv|démo|démonstration/i,
            response: "Parfait ! Je peux organiser une démo gratuite. Préférez-vous cette semaine ou la semaine prochaine ?"
        }
    ],
    
    check: function(text) {
        for (const pattern of this.patterns) {
            if (pattern.regex.test(text)) {
                return pattern.response;
            }
        }
        return null;
    }
};

// Route principale optimisée avec Wavenet
app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    
    console.log(`📞 APPEL: ${callSid} - ${req.body.From}`);
    
    // Initialiser profil et conversation
    userProfiles.set(callSid, {
        phone: req.body.From,
        startTime: Date.now(),
        interactions: 0
    });
    conversations.set(callSid, []);
    
    // Message d'accueil temporaire avec voix basique
    twiml.say(FALLBACK_VOICE, 'Bonjour! Dynophone de Dynovate à votre service!');
    
    // Gather ultra-optimisé
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
    
    twiml.say(FALLBACK_VOICE, 'Merci de votre appel. Un expert vous recontactera. Bonne journée!');
    
    twiml.hangup();
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Traitement speech ultra-optimisé
app.post('/process-speech', async (req, res) => {
    const startTime = Date.now();
    const twiml = new twilio.twiml.VoiceResponse();
    const speechResult = req.body.SpeechResult || '';
    const callSid = req.body.CallSid;
    
    if (!speechResult.trim()) {
        return sendFallbackResponse(res, twiml, callSid);
    }
    
    console.log(`🎤 ${callSid}: "${speechResult}"`);
    
    try {
        // 1. Vérifier réponses rapides en premier (0ms)
        const quickResponse = QUICK_RESPONSES.check(speechResult);
        if (quickResponse) {
            console.log(`⚡ Réponse rapide en ${Date.now() - startTime}ms`);
            
            if (quickResponse.includes('FIN_APPEL')) {
                twiml.say(FALLBACK_VOICE, quickResponse.replace('FIN_APPEL', ''));
                twiml.hangup();
                cleanupCall(callSid);
                res.type('text/xml');
                return res.send(twiml.toString());
            } else {
                await sendVoiceResponse(res, twiml, quickResponse, callSid, false);
                return;
            }
        }
        
        // 2. Vérifier cache
        const cacheKey = speechResult.toLowerCase().trim();
        if (responseCache.has(cacheKey)) {
            const cached = responseCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_DURATION) {
                console.log(`💾 Cache hit en ${Date.now() - startTime}ms`);
                await sendVoiceResponse(res, twiml, cached.response, callSid, false);
                return;
            }
        }
        
        // 3. Récupérer contexte conversation
        const conversation = conversations.get(callSid) || [];
        const userProfile = userProfiles.get(callSid) || {};
        
        // Incrémenter interactions
        userProfile.interactions = (userProfile.interactions || 0) + 1;
        userProfiles.set(callSid, userProfile);
        
        // Ajouter message utilisateur
        conversation.push({ role: 'user', content: speechResult });
        
        // 4. Appel Groq OPTIMISÉ
        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: DYNOVATE_CONTEXT },
                ...conversation.slice(-4)
            ],
            temperature: 0.3,
            max_tokens: 50,
            stream: false,
            top_p: 0.9
        });
        
        let aiResponse = completion.choices[0].message.content.trim();
        
        // Sauvegarder dans cache
        responseCache.set(cacheKey, {
            response: aiResponse,
            timestamp: Date.now()
        });
        
        // Vérifier si l'IA signale fin d'appel
        const shouldEndCall = aiResponse.includes('FIN_APPEL');
        if (shouldEndCall) {
            aiResponse = aiResponse.replace('FIN_APPEL', '').trim();
        }
        
        // Sauvegarder conversation
        conversation.push({ role: 'assistant', content: aiResponse });
        conversations.set(callSid, conversation);
        
        // Extraire infos utilisateur
        extractUserInfo(callSid, speechResult, aiResponse);
        
        const processingTime = Date.now() - startTime;
        console.log(`⚡ ${callSid} [GROQ] (${processingTime}ms): "${aiResponse}"`);
        
        // Réponse vocale
        await sendVoiceResponse(res, twiml, aiResponse, callSid, shouldEndCall);
        
    } catch (error) {
        console.error(`❌ Erreur ${callSid}:`, error);
        return sendFallbackResponse(res, twiml, callSid);
    }
});

// Réponse vocale avec Cartesia AI (1$ crédit gratuit = 1M caractères)
async function sendVoiceResponse(res, twiml, text, callSid, shouldEndCall) {
    let audioUsed = false;
    
    // Essayer Cartesia AI (ultra rapide et naturel)
    if (CARTESIA_API_KEY && !audioUsed) {
        try {
            console.log(`🎯 Tentative Cartesia AI...`);
            
            const response = await axios.post(
                'https://api.cartesia.ai/tts/bytes',
                {
                    model_id: 'sonic-multilingual',
                    transcript: text,
                    voice: {
                        mode: 'id',
                        id: 'a0e99841-438c-4a64-b679-ae501e7d6091' // Voix française "Sophie"
                    },
                    output_format: {
                        container: 'mp3',
                        encoding: 'mp3',
                        sample_rate: 44100
                    },
                    language: 'fr'
                },
                {
                    headers: {
                        'Cartesia-Version': '2024-06-10',
                        'X-API-Key': CARTESIA_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    responseType: 'arraybuffer',
                    timeout: 1000 // Super rapide
                }
            );
            
            if (response.data && response.data.byteLength > 0) {
                const audioUrl = `data:audio/mpeg;base64,${Buffer.from(response.data).toString('base64')}`;
                twiml.play({ loop: 1 }, audioUrl);
                audioUsed = true;
                console.log(`✅ Cartesia AI réussi - voix ultra naturelle!`);
            }
        } catch (error) {
            console.log(`⚠️ Cartesia échec: ${error.message}`);
        }
    }
    
    // Fallback voix basique si Cartesia échoue
    if (!audioUsed) {
        console.log(`🔊 Fallback voix standard`);
        twiml.say(FALLBACK_VOICE, text);
    }
    
    // Gestion fin d'appel ou continuation
    if (shouldEndCall) {
        console.log(`🏁 Fin d'appel: ${callSid}`);
        twiml.pause({ length: 1 });
        twiml.hangup();
        cleanupCall(callSid);
    } else {
        // Continuer conversation avec timeouts optimisés
        const profile = userProfiles.get(callSid) || {};
        const timeoutDuration = profile.interactions > 3 ? 4 : 6;
        
        const gather = twiml.gather({
            input: 'speech',
            language: 'fr-FR',
            speechTimeout: 1,
            timeout: timeoutDuration,
            action: '/process-speech',
            method: 'POST',
            speechModel: 'experimental_conversations',
            enhanced: true
        });
        
        twiml.say(FALLBACK_VOICE, 'Merci pour votre temps. Un expert vous recontactera. Excellente journée!');
        
        twiml.hangup();
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
}

// Extraction automatique d'informations
function extractUserInfo(callSid, speech, response) {
    const profile = userProfiles.get(callSid) || {};
    const lowerSpeech = speech.toLowerCase();
    
    // Extraction email
    const emailMatch = speech.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (emailMatch) {
        profile.email = emailMatch[0];
        console.log(`📧 Email collecté: ${profile.email}`);
    }
    
    // Détection secteur
    const sectors = [
        { keywords: ['restaurant', 'café', 'bar', 'brasserie'], name: 'Restauration' },
        { keywords: ['immobilier', 'agence', 'location', 'vente'], name: 'Immobilier' },
        { keywords: ['commerce', 'boutique', 'magasin', 'vente'], name: 'Commerce' },
        { keywords: ['médical', 'médecin', 'cabinet', 'clinique'], name: 'Médical' }
    ];
    
    for (const sector of sectors) {
        if (sector.keywords.some(keyword => lowerSpeech.includes(keyword))) {
            profile.sector = sector.name;
            break;
        }
    }
    
    userProfiles.set(callSid, profile);
}

// Nettoyage conversation
function cleanupCall(callSid) {
    const profile = userProfiles.get(callSid);
    if (profile) {
        const duration = Math.round((Date.now() - profile.startTime) / 1000);
        console.log(`📊 Appel ${callSid}: ${duration}s, ${profile.interactions} interactions`);
        
        if (profile.email || profile.sector) {
            console.log(`💰 Lead: ${profile.email || 'Pas d\'email'} - ${profile.sector || 'Secteur inconnu'}`);
        }
    }
    
    conversations.delete(callSid);
    userProfiles.delete(callSid);
}

function sendFallbackResponse(res, twiml, callSid) {
    console.log(`🚨 Fallback: ${callSid}`);
    
    twiml.say(FALLBACK_VOICE, 'Un instant s\'il vous plaît.');
    
    const gather = twiml.gather({
        input: 'speech',
        language: 'fr-FR',
        speechTimeout: 1,
        timeout: 5,
        action: '/process-speech',
        method: 'POST'
    });
    
    res.type('text/xml');
    res.send(twiml.toString());
}

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK',
        uptime: Math.round(process.uptime()),
        activeConversations: conversations.size,
        cacheSize: responseCache.size,
        voice: 'Cartesia AI Sophie',
        tts_engine: 'Neural',
        status: CARTESIA_API_KEY ? 'Active' : 'Fallback mode'
    });
});

// Analytics endpoint
app.get('/analytics', (req, res) => {
    const analytics = [];
    
    for (const [callSid, conversation] of conversations.entries()) {
        const profile = userProfiles.get(callSid) || {};
        const duration = profile.startTime ? 
            Math.round((Date.now() - profile.startTime) / 1000) : 0;
        
        analytics.push({
            callSid,
            phone: profile.phone,
            duration: `${duration}s`,
            interactions: profile.interactions || 0,
            email: profile.email || null,
            sector: profile.sector || null
        });
    }
    
    res.json({
        total: analytics.length,
        leads: analytics.filter(a => a.email).length,
        conversations: analytics
    });
});

// Nettoyage périodique
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;
    
    let cleaned = 0;
    for (const [callSid, profile] of userProfiles.entries()) {
        if (now - profile.startTime > maxAge) {
            conversations.delete(callSid);
            userProfiles.delete(callSid);
            cleaned++;
        }
    }
    
    // Nettoyer cache ancien
    for (const [key, value] of responseCache.entries()) {
        if (now - value.timestamp > CACHE_DURATION) {
            responseCache.delete(key);
        }
    }
    
    if (cleaned > 0) {
        console.log(`🧹 ${cleaned} conversations nettoyées`);
    }
}, 10 * 60 * 1000);

// Démarrage serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    🚀 Dynovate Assistant IA - Version Optimisée
    ⚡ Port: ${PORT}
    🤖 Groq: ${process.env.GROQ_API_KEY ? '✅' : '❌'}
    🎯 Cartesia AI: ${CARTESIA_API_KEY ? '✅ Voix naturelle activée!' : '❌ Ajoute CARTESIA_API_KEY'}
    📊 Latence: 300-450ms IA + 50ms TTS
    💡 Info: Cartesia offre 1$ crédit = 1 million de caractères!
    ✨ Endpoints:
       - POST /voice (entrée appel)
       - POST /process-speech (traitement)
       - GET /health (monitoring)
       - GET /analytics (statistiques)
    `);
});