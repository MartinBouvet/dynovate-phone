const express = require('express');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();

// Configuration optimisée
const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY || 'gsk_dummy_key_for_init'
});

// Hugging Face pour TTS gratuit
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;

// Stockage conversations en mémoire
const conversations = new Map();
const userProfiles = new Map();
const responseCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000;

// Middleware
app.use(express.urlencoded({ extended: false }));

// Contexte Dynovate
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

// Réponses rapides pré-définies
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
    
    // Message d'accueil - on teste d'abord avec la voix standard
    twiml.say({
        voice: 'alice',
        language: 'fr-FR'
    }, 'Bonjour! Dynophone de Dynovate à votre service!');
    
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
    
    twiml.say({
        voice: 'alice',
        language: 'fr-FR'
    }, 'Merci de votre appel. Un expert vous recontactera. Bonne journée!');
    
    twiml.hangup();
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Traitement speech
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
        // 1. Vérifier réponses rapides
        const quickResponse = QUICK_RESPONSES.check(speechResult);
        if (quickResponse) {
            console.log(`⚡ Réponse rapide en ${Date.now() - startTime}ms`);
            
            if (quickResponse.includes('FIN_APPEL')) {
                twiml.say({
                    voice: 'alice',
                    language: 'fr-FR'
                }, quickResponse.replace('FIN_APPEL', ''));
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
        
        // 3. Préparer conversation
        const conversation = conversations.get(callSid) || [];
        const userProfile = userProfiles.get(callSid) || {};
        
        userProfile.interactions = (userProfile.interactions || 0) + 1;
        userProfiles.set(callSid, userProfile);
        
        conversation.push({ role: 'user', content: speechResult });
        
        // 4. Appel Groq avec fallback
        let aiResponse = "Nos solutions d'IA améliorent votre relation client. Quel est votre secteur d'activité ?";
        
        try {
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
            
            aiResponse = completion.choices[0].message.content.trim();
        } catch (groqError) {
            console.error(`⚠️ Erreur Groq: ${groqError.message}`);
        }
        
        // Sauvegarder
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
        
        await sendVoiceResponse(res, twiml, aiResponse, callSid, shouldEndCall);
        
    } catch (error) {
        console.error(`❌ Erreur ${callSid}:`, error);
        return sendFallbackResponse(res, twiml, callSid);
    }
});

// Fonction TTS avec Hugging Face
async function generateHuggingFaceAudio(text) {
    if (!HUGGINGFACE_API_KEY) {
        console.log('❌ Pas de clé Hugging Face');
        return null;
    }
    
    try {
        console.log(`🤗 Génération audio HF pour: "${text.substring(0, 30)}..."`);
        
        // Modèle français MMS de Facebook
        const response = await axios({
            method: 'POST',
            url: 'https://api-inference.huggingface.co/models/facebook/mms-tts-fra',
            headers: {
                'Authorization': `Bearer ${HUGGINGFACE_API_KEY}`,
                'Content-Type': 'application/json',
            },
            data: JSON.stringify({ 
                inputs: text
            }),
            responseType: 'arraybuffer',
            timeout: 3000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });
        
        if (response.data && response.data.byteLength > 0) {
            console.log(`✅ HF audio généré: ${response.data.byteLength} bytes`);
            return Buffer.from(response.data).toString('base64');
        }
        
    } catch (error) {
        if (error.response?.status === 503) {
            console.log('⏳ Modèle HF en cours de chargement, réessai...');
            
            // Essayer un modèle alternatif plus léger
            try {
                const altResponse = await axios({
                    method: 'POST',
                    url: 'https://api-inference.huggingface.co/models/espnet/kan-bayashi_ljspeech_vits',
                    headers: {
                        'Authorization': `Bearer ${HUGGINGFACE_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    data: JSON.stringify({ 
                        inputs: text,
                        parameters: {
                            language: 'fr'
                        }
                    }),
                    responseType: 'arraybuffer',
                    timeout: 3000
                });
                
                if (altResponse.data && altResponse.data.byteLength > 0) {
                    console.log(`✅ HF alternatif réussi: ${altResponse.data.byteLength} bytes`);
                    return Buffer.from(altResponse.data).toString('base64');
                }
            } catch (altError) {
                console.log(`❌ HF alternatif échec: ${altError.message}`);
            }
        } else {
            console.log(`❌ Erreur HF: ${error.message}`);
        }
    }
    
    return null;
}

// Réponse vocale
async function sendVoiceResponse(res, twiml, text, callSid, shouldEndCall) {
    let audioUsed = false;
    
    // Essayer Hugging Face en premier
    if (HUGGINGFACE_API_KEY) {
        const audioBase64 = await generateHuggingFaceAudio(text);
        
        if (audioBase64) {
            console.log('🎵 Utilisation audio Hugging Face');
            // HF renvoie du WAV, on le joue directement
            twiml.play({
                loop: 1
            }, `data:audio/wav;base64,${audioBase64}`);
            audioUsed = true;
        }
    }
    
    // Fallback vers voix standard si HF échoue
    if (!audioUsed) {
        console.log('🔊 Fallback voix Alice');
        twiml.say({
            voice: 'alice',
            language: 'fr-FR'
        }, text);
    }
    
    // Gestion fin d'appel
    if (shouldEndCall) {
        console.log(`🏁 Fin d'appel: ${callSid}`);
        twiml.pause({ length: 1 });
        twiml.hangup();
        cleanupCall(callSid);
    } else {
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
        
        twiml.say({
            voice: 'alice',
            language: 'fr-FR'
        }, 'Merci pour votre temps. Un expert vous recontactera. Excellente journée!');
        
        twiml.hangup();
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
}

// Extraction infos utilisateur
function extractUserInfo(callSid, speech, response) {
    const profile = userProfiles.get(callSid) || {};
    const lowerSpeech = speech.toLowerCase();
    
    const emailMatch = speech.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (emailMatch) {
        profile.email = emailMatch[0];
        console.log(`📧 Email collecté: ${profile.email}`);
    }
    
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

// Nettoyage
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

// Fallback
function sendFallbackResponse(res, twiml, callSid) {
    console.log(`🚨 Fallback: ${callSid}`);
    
    twiml.say({
        voice: 'alice',
        language: 'fr-FR'
    }, 'Un instant s\'il vous plaît.');
    
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
        voice: HUGGINGFACE_API_KEY ? 'Hugging Face TTS' : 'Alice Standard',
        tts_status: HUGGINGFACE_API_KEY ? 'Active' : 'Fallback'
    });
});

// Test endpoint pour HF
app.get('/test-hf', async (req, res) => {
    if (!HUGGINGFACE_API_KEY) {
        return res.json({ error: 'Pas de clé HF configurée' });
    }
    
    const testText = "Bonjour, ceci est un test de synthèse vocale.";
    const audio = await generateHuggingFaceAudio(testText);
    
    if (audio) {
        res.json({ 
            success: true, 
            audioLength: audio.length,
            message: 'Audio généré avec succès'
        });
    } else {
        res.json({ 
            success: false,
            message: 'Échec génération audio'
        });
    }
});

// Analytics
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
    🚀 Dynovate Assistant IA - Version Hugging Face
    ⚡ Port: ${PORT}
    🤖 Groq: ${process.env.GROQ_API_KEY ? '✅' : '❌'}
    🤗 Hugging Face: ${HUGGINGFACE_API_KEY ? '✅ TTS Gratuit activé!' : '❌ Ajoute HUGGINGFACE_API_KEY'}
    📊 Latence: 300-450ms IA + 100-200ms TTS
    🔊 Voix: ${HUGGINGFACE_API_KEY ? 'MMS-TTS-FRA (Facebook)' : 'Alice Standard'}
    
    ✨ Endpoints:
       - POST /voice (entrée appel)
       - POST /process-speech (traitement)
       - GET /health (monitoring)
       - GET /test-hf (test audio HF)
       - GET /analytics (statistiques)
    
    💡 ${HUGGINGFACE_API_KEY ? 'TTS Hugging Face actif!' : 'Ajoute HUGGINGFACE_API_KEY pour voix naturelle gratuite'}
    `);
});