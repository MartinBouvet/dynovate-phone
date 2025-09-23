const express = require('express');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();

// Configuration optimisée
const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY || 'gsk_dummy_key_for_init'
});

// ElevenLabs configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel par défaut

// Vérification au démarrage
if (!process.env.GROQ_API_KEY) {
    console.error('⚠️  GROQ_API_KEY manquante! Ajoutez-la dans Railway > Variables');
}
if (!ELEVENLABS_API_KEY) {
    console.error('⚠️  ELEVENLABS_API_KEY manquante! Ajoutez-la dans Railway > Variables');
}

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

// Route principale - CORRIGÉE pour ne pas bloquer
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
    
    // Message d'accueil SANS AWAIT pour ne pas bloquer
    if (!ELEVENLABS_API_KEY) {
        twiml.say({
            voice: 'alice',
            language: 'fr-FR'
        }, 'Bonjour! Dynophone de Dynovate à votre service!');
    } else {
        // Pour l'instant, utiliser la voix standard pour l'accueil (plus rapide)
        twiml.say({
            voice: 'alice',
            language: 'fr-FR'
        }, 'Bonjour! Dynophone de Dynovate à votre service!');
    }
    
    // Gather pour écouter la réponse
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
    
    // Si pas de réponse
    twiml.say({
        voice: 'alice',
        language: 'fr-FR'
    }, 'Je vous écoute!');
    
    // Redirection si timeout complet
    twiml.redirect('/voice');
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Traitement speech optimisé
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
            // Réponses de fallback intelligentes
            if (speechResult.toLowerCase().includes('demo') || speechResult.toLowerCase().includes('rdv')) {
                aiResponse = "Parfait ! Je peux organiser une démo gratuite. Préférez-vous cette semaine ou la semaine prochaine ?";
            }
        }
        
        // Sauvegarder dans cache
        responseCache.set(cacheKey, {
            response: aiResponse,
            timestamp: Date.now()
        });
        
        // Vérifier si fin d'appel
        const shouldEndCall = aiResponse.includes('FIN_APPEL');
        if (shouldEndCall) {
            aiResponse = aiResponse.replace('FIN_APPEL', '').trim();
        }
        
        // Sauvegarder conversation
        conversation.push({ role: 'assistant', content: aiResponse });
        conversations.set(callSid, conversation);
        
        // Extraire infos utilisateur
        extractUserInfo(callSid, speechResult, aiResponse);
        
        console.log(`⚡ ${callSid} [GROQ] (${Date.now() - startTime}ms): "${aiResponse}"`);
        
        // Envoyer réponse vocale
        await sendVoiceResponse(res, twiml, aiResponse, callSid, shouldEndCall);
        
    } catch (error) {
        console.error(`❌ Erreur ${callSid}:`, error);
        return sendFallbackResponse(res, twiml, callSid);
    }
});

// Fonction TTS avec ElevenLabs - VERSION OPTIMISÉE
async function generateElevenLabsAudio(text) {
    if (!ELEVENLABS_API_KEY) {
        return null;
    }
    
    try {
        const startTime = Date.now();
        console.log(`🎵 Génération ElevenLabs: "${text.substring(0, 40)}..."`);
        
        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg',
                'optimize_streaming_latency': '4' // Optimisation maximale
            },
            data: {
                text: text,
                model_id: 'eleven_turbo_v2_5', // Modèle Turbo pour latence minimale
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.8,
                    style: 0.3,
                    use_speaker_boost: true
                },
                optimize_streaming_latency: 4 // Maximum d'optimisation
            },
            responseType: 'arraybuffer',
            timeout: 2500 // 2.5 secondes max
        });
        
        if (response.data && response.data.byteLength > 0) {
            const latency = Date.now() - startTime;
            console.log(`✅ ElevenLabs réussi: ${response.data.byteLength} bytes en ${latency}ms`);
            return Buffer.from(response.data).toString('base64');
        }
        
    } catch (error) {
        console.error(`❌ Erreur ElevenLabs: ${error.response?.status || error.message}`);
        if (error.response?.data) {
            console.error('Détails:', Buffer.from(error.response.data).toString());
        }
        if (error.response?.status === 401) {
            console.error('🔑 Clé API ElevenLabs invalide!');
        } else if (error.response?.status === 429) {
            console.error('📊 Quota ElevenLabs dépassé!');
        }
    }
    
    return null;
}

// Réponse vocale avec ElevenLabs - OPTIMISÉE
async function sendVoiceResponse(res, twiml, text, callSid, shouldEndCall) {
    const startTime = Date.now();
    let audioUsed = false;
    
    // Essayer ElevenLabs en premier
    if (ELEVENLABS_API_KEY) {
        const audioBase64 = await generateElevenLabsAudio(text);
        
        if (audioBase64) {
            console.log(`🎵 Lecture audio ElevenLabs (${Date.now() - startTime}ms)`);
            twiml.play({
                loop: 1
            }, `data:audio/mpeg;base64,${audioBase64}`);
            audioUsed = true;
        }
    }
    
    // Fallback vers voix standard si ElevenLabs échoue
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
        const timeoutDuration = profile.interactions > 3 ? 3 : 5; // Plus court
        
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
        
        // Petit message si silence
        gather.say({
            voice: 'alice',
            language: 'fr-FR'
        }, 'Je vous écoute.');
        
        // Message de fin si timeout complet
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

// Extraction infos utilisateur
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
        { keywords: ['médical', 'médecin', 'cabinet', 'clinique'], name: 'Médical' },
        { keywords: ['garage', 'automobile', 'voiture'], name: 'Automobile' },
        { keywords: ['coiffure', 'salon', 'beauté'], name: 'Beauté' }
    ];
    
    for (const sector of sectors) {
        if (sector.keywords.some(keyword => lowerSpeech.includes(keyword))) {
            profile.sector = sector.name;
            console.log(`🏢 Secteur détecté: ${profile.sector}`);
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
        console.log(`📊 Appel terminé - Durée: ${duration}s, Interactions: ${profile.interactions}`);
        
        if (profile.email || profile.sector) {
            console.log(`💰 LEAD QUALIFIÉ:`);
            console.log(`   📧 Email: ${profile.email || 'Non collecté'}`);
            console.log(`   🏢 Secteur: ${profile.sector || 'Non identifié'}`);
            console.log(`   📞 Téléphone: ${profile.phone}`);
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
        tts: {
            provider: ELEVENLABS_API_KEY ? 'ElevenLabs' : 'Alice (Fallback)',
            voice_id: ELEVENLABS_VOICE_ID,
            status: ELEVENLABS_API_KEY ? 'Active' : 'Fallback mode'
        }
    });
});

// Endpoint de test ElevenLabs
app.get('/test-elevenlabs', async (req, res) => {
    if (!ELEVENLABS_API_KEY) {
        return res.json({ 
            error: 'ELEVENLABS_API_KEY non configurée',
            solution: 'Ajoutez ELEVENLABS_API_KEY dans Railway > Variables'
        });
    }
    
    const testText = "Test de synthèse vocale avec ElevenLabs.";
    const audio = await generateElevenLabsAudio(testText);
    
    if (audio) {
        res.json({ 
            success: true, 
            audioLength: audio.length,
            message: 'Audio ElevenLabs généré avec succès!',
            voice_id: ELEVENLABS_VOICE_ID
        });
    } else {
        res.json({ 
            success: false,
            message: 'Échec génération audio ElevenLabs',
            check: 'Vérifiez votre clé API et votre quota'
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
    
    // Nettoyer cache
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
    🚀 Dynovate Assistant IA - Version ElevenLabs
    ⚡ Port: ${PORT}
    🤖 Groq: ${process.env.GROQ_API_KEY ? '✅' : '❌ Ajoute GROQ_API_KEY'}
    🎵 ElevenLabs: ${ELEVENLABS_API_KEY ? '✅ Voix naturelle activée!' : '❌ Ajoute ELEVENLABS_API_KEY'}
    📊 Latence: 300-450ms IA + 100-150ms TTS
    🔊 Voix: ${ELEVENLABS_API_KEY ? 'ElevenLabs Turbo v2.5' : 'Alice (Fallback)'}
    
    ✨ Endpoints:
       - POST /voice (entrée appel)
       - POST /process-speech (traitement)
       - GET /health (monitoring)
       - GET /test-elevenlabs (test voix)
       - GET /analytics (statistiques)
    
    ${ELEVENLABS_API_KEY ? 
        '✅ ElevenLabs configuré - Voix naturelle active!' : 
        '⚠️  Ajoutez ELEVENLABS_API_KEY pour activer la voix naturelle'}
    `);
    
    // Vérifier le quota ElevenLabs au démarrage
    if (ELEVENLABS_API_KEY) {
        axios.get('https://api.elevenlabs.io/v1/user', {
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY
            }
        }).then(response => {
            const subscription = response.data.subscription;
            console.log(`
    💳 ElevenLabs - Plan: ${subscription.tier}
    📊 Caractères utilisés: ${subscription.character_count} / ${subscription.character_limit}
    📅 Reset: ${new Date(subscription.next_character_count_reset_unix * 1000).toLocaleDateString()}
            `);
        }).catch(error => {
            console.error('⚠️  Impossible de vérifier le quota ElevenLabs');
        });
    }
});