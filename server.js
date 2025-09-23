const express = require('express');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();

// Configuration
const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY || 'gsk_dummy_key_for_init'
});

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

// Stockage global pour l'audio
global.audioQueue = {};

// Stockage conversations
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
- Détecte signaux de fin: "merci", "ça suffit", "non merci", "au revoir"

GESTION FIN D'APPEL:
Si client dit: "merci", "non merci", "ça suffit", "au revoir", "c'est bon":
→ Termine poliment: "Merci pour votre temps ! N'hésitez pas à nous rappeler. Un expert vous recontactera si vous le souhaitez. Excellente journée !"
→ Ajoute "FIN_APPEL" à la fin de ta réponse

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

// ENDPOINT AUDIO ELEVENLABS - VOIX FRANÇAISE CORRECTE
app.get('/generate-audio/:token', async (req, res) => {
    const token = req.params.token;
    const text = global.audioQueue[token];
    
    if (!text) {
        console.log('❌ Texte non trouvé pour token:', token);
        return res.status(404).send('Audio not found');
    }
    
    if (!ELEVENLABS_API_KEY) {
        console.log('❌ Pas de clé ElevenLabs');
        return res.status(500).send('ElevenLabs not configured');
    }
    
    try {
        console.log(`🎵 Génération audio pour: "${text.substring(0, 40)}..."`);
        
        // IMPORTANT: Utiliser une voix française ou multilingue
        const voiceId = ELEVENLABS_VOICE_ID === '21m00Tcm4TlvDq8ikWAM' 
            ? 'ThT5KcBeYPX3keUQqHPh'  // Voix française Nicole
            : ELEVENLABS_VOICE_ID;
        
        // Appel API ElevenLabs avec paramètres français
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
                model_id: 'eleven_multilingual_v2',  // MODÈLE MULTILINGUE
                voice_settings: {
                    stability: 0.6,
                    similarity_boost: 0.8,
                    style: 0.0,  // Pas de style pour éviter l'accent
                    use_speaker_boost: false  // Désactivé pour voix plus naturelle
                }
            },
            responseType: 'stream'
        });
        
        // Nettoyer la queue
        delete global.audioQueue[token];
        
        // Headers pour Twilio
        res.set({
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Transfer-Encoding': 'chunked'
        });
        
        // Streamer directement l'audio
        response.data.pipe(res);
        
        console.log(`✅ Audio ElevenLabs streamé (voix: ${voiceId})`);
        
    } catch (error) {
        console.error(`❌ Erreur génération: ${error.response?.status || error.message}`);
        if (error.response?.data) {
            const errorText = Buffer.from(error.response.data).toString();
            console.error('Détails erreur:', errorText);
        }
        delete global.audioQueue[token];
        res.status(500).send('Error generating audio');
    }
});

// Route principale - MESSAGE D'ACCUEIL AVEC ELEVENLABS
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
    
    // Message d'accueil AVEC ELEVENLABS
    if (ELEVENLABS_API_KEY) {
        try {
            const welcomeText = "Bonjour! Dynophone de Dynovate à votre service!";
            const audioToken = Buffer.from(`welcome:${callSid}:${Date.now()}`).toString('base64url');
            
            global.audioQueue[audioToken] = welcomeText;
            
            const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : `https://${req.headers.host}`;
            
            const audioUrl = `${baseUrl}/generate-audio/${audioToken}`;
            
            console.log(`🎵 Audio accueil: ${audioUrl}`);
            twiml.play(audioUrl);
            
        } catch (error) {
            console.error('Erreur accueil:', error);
            twiml.say({
                voice: 'alice',
                language: 'fr-FR'
            }, 'Bonjour! Dynophone de Dynovate à votre service!');
        }
    } else {
        twiml.say({
            voice: 'alice',
            language: 'fr-FR'
        }, 'Bonjour! Dynophone de Dynovate à votre service!');
    }
    
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
    
    gather.say({
        voice: 'alice',
        language: 'fr-FR'
    }, 'Je vous écoute!');
    
    twiml.redirect('/voice');
    
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
                const cleanResponse = quickResponse.replace('FIN_APPEL', '');
                await sendVoiceResponse(res, twiml, cleanResponse, callSid, true);
                return;
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
        
        // 4. Appel Groq
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

// FONCTION CRITIQUE - Réponse vocale avec ElevenLabs via URL
async function sendVoiceResponse(res, twiml, text, callSid, shouldEndCall) {
    const startTime = Date.now();
    let audioUsed = false;
    
    // Utiliser ElevenLabs si disponible
    if (ELEVENLABS_API_KEY) {
        try {
            // Créer un token unique pour cette réponse
            const audioToken = Buffer.from(`${callSid}:${Date.now()}:${Math.random()}`).toString('base64url');
            
            // Stocker le texte pour l'endpoint
            global.audioQueue[audioToken] = text;
            
            // Obtenir l'URL de base depuis Railway ou localhost
            const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : `https://${req.headers.host || 'localhost:3000'}`;
            
            const audioUrl = `${baseUrl}/generate-audio/${audioToken}`;
            
            console.log(`🎵 Audio URL: ${audioUrl}`);
            
            // Dire à Twilio de jouer l'audio depuis notre endpoint
            twiml.play(audioUrl);
            audioUsed = true;
            
            console.log(`✅ Audio ElevenLabs configuré pour lecture`);
            
        } catch (error) {
            console.error(`❌ Erreur config ElevenLabs: ${error.message}`);
        }
    }
    
    // Fallback si ElevenLabs non disponible
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
        // Continuer conversation
        const profile = userProfiles.get(callSid) || {};
        const timeoutDuration = profile.interactions > 3 ? 3 : 5;
        
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
        
        gather.say({
            voice: 'alice',
            language: 'fr-FR'
        }, 'Je vous écoute.');
        
        twiml.say({
            voice: 'alice',
            language: 'fr-FR'
        }, 'Merci pour votre appel. Un expert vous recontactera!');
        
        twiml.hangup();
    }
    
    console.log(`⏱️ Réponse totale en ${Date.now() - startTime}ms`);
    res.type('text/xml');
    res.send(twiml.toString());
}

// Extraction infos
function extractUserInfo(callSid, speech, response) {
    const profile = userProfiles.get(callSid) || {};
    const lowerSpeech = speech.toLowerCase();
    
    const emailMatch = speech.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (emailMatch) {
        profile.email = emailMatch[0];
        console.log(`📧 Email collecté: ${profile.email}`);
    }
    
    const sectors = [
        { keywords: ['restaurant', 'café', 'bar'], name: 'Restauration' },
        { keywords: ['immobilier', 'agence'], name: 'Immobilier' },
        { keywords: ['commerce', 'boutique'], name: 'Commerce' },
        { keywords: ['médical', 'médecin'], name: 'Médical' }
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
        console.log(`📊 Appel terminé - ${duration}s`);
        
        if (profile.email || profile.sector) {
            console.log(`💰 LEAD: ${profile.email || 'N/A'} - ${profile.sector || 'N/A'}`);
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
        elevenlabs: ELEVENLABS_API_KEY ? 'Configured' : 'Missing',
        groq: process.env.GROQ_API_KEY ? 'Configured' : 'Missing',
        activeConversations: conversations.size,
        audioQueueSize: Object.keys(global.audioQueue).length
    });
});

// Test ElevenLabs
app.get('/test-elevenlabs', async (req, res) => {
    if (!ELEVENLABS_API_KEY) {
        return res.json({ error: 'ELEVENLABS_API_KEY not configured' });
    }
    
    try {
        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json'
            },
            data: {
                text: "Test audio",
                model_id: 'eleven_monolingual_v1'
            },
            responseType: 'arraybuffer'
        });
        
        res.json({ 
            success: true,
            audioSize: response.data.byteLength,
            message: 'ElevenLabs works!'
        });
    } catch (error) {
        res.json({ 
            success: false,
            error: error.response?.status || error.message
        });
    }
});

// Nettoyage périodique
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;
    
    for (const [callSid, profile] of userProfiles.entries()) {
        if (now - profile.startTime > maxAge) {
            conversations.delete(callSid);
            userProfiles.delete(callSid);
        }
    }
    
    // Nettoyer audio queue
    const queueSize = Object.keys(global.audioQueue).length;
    if (queueSize > 100) {
        global.audioQueue = {};
        console.log('🧹 Audio queue nettoyée');
    }
}, 10 * 60 * 1000);

// Démarrage
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    🚀 Dynovate Assistant IA avec ElevenLabs
    ⚡ Port: ${PORT}
    🤖 Groq: ${process.env.GROQ_API_KEY ? '✅' : '❌'}
    🎵 ElevenLabs: ${ELEVENLABS_API_KEY ? '✅' : '❌'}
    
    📱 Configuration Twilio:
       Webhook URL: https://ton-app.railway.app/voice
       Method: POST
    
    🔊 Audio endpoint: /generate-audio/:token
    🏥 Health check: /health
    🧪 Test ElevenLabs: /test-elevenlabs
    `);
    
    if (ELEVENLABS_API_KEY) {
        axios.get('https://api.elevenlabs.io/v1/user', {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY }
        }).then(response => {
            console.log(`
    💳 Plan: ${response.data.subscription.tier}
    📊 Usage: ${response.data.subscription.character_count}/${response.data.subscription.character_limit}
            `);
        }).catch(() => {
            console.log('⚠️  Impossible de vérifier le quota ElevenLabs');
        });
    }
});