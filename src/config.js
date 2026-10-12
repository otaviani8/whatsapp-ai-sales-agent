import 'dotenv/config';

// ============================================================================
//  ENV  —  configuración de entorno (infra). Para cambiar cómo HABLA el bot,
//  no toques esto: editá src/persona.js.
// ============================================================================
const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

export const ENV = {
  // --- Claude ---
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  // Default Haiku 5.5 desde el 07/10/2026 (decisión de producto: mejor y más barato que los
  // anteriores). Soporta razonamiento adaptativo. El código se adapta solo a cada modelo.
  CLAUDE_MODEL: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',

  // --- Google ---
  GOOGLE_CREDENTIALS_JSON: process.env.GOOGLE_CREDENTIALS_JSON || '',
  GOOGLE_CREDENTIALS_B64: process.env.GOOGLE_CREDENTIALS_B64 || '',
  CALENDAR_ID: process.env.CALENDAR_ID || 'primary',
  TIMEZONE: process.env.TIMEZONE || 'America/Argentina/Buenos_Aires',
  // Link fijo de Google Meet para las videollamadas (lo crea Martín una vez,
  // reutilizable). El bot lo mete en el evento y se lo pasa al lead.
  MEET_LINK: process.env.MEET_LINK || '',

  // --- CRM (Google Sheet, opcional) ---
  // Si está seteado, el bot mantiene una fila por lead al día. Compartí la
  // planilla con el email de la service account como Editor.
  SHEET_ID: process.env.SHEET_ID || '',
  SHEET_TAB: process.env.SHEET_TAB || 'CRM',
  // Pestaña-registro de llamadas agendadas: el bot AGREGA una fila por cada
  // reserva (fecha, lead, teléfono, día/hora de la call, links). Usa el mismo
  // SHEET_ID. Es el canal de aviso de agendados (no depende de la ventana de 24h).
  BOOKINGS_TAB: process.env.BOOKINGS_TAB || 'AGENDADAS',

  // --- WhatsApp Cloud API (Meta oficial) ---
  // Token de acceso (System User permanente para prod; temporal de 24h para probar).
  WA_TOKEN: process.env.WA_TOKEN || '',
  // Identificador del número de teléfono (Phone Number ID) desde el que envía el bot.
  WA_PHONE_NUMBER_ID: process.env.WA_PHONE_NUMBER_ID || '',
  // Identificador de la cuenta de WhatsApp Business (para plantillas/gestión).
  WABA_ID: process.env.WABA_ID || '',
  // String que vos elegís y ponés IGUAL acá y en la config del webhook en Meta.
  WA_VERIFY_TOKEN: process.env.WA_VERIFY_TOKEN || '',
  // App Secret (opcional) para verificar la firma del webhook (X-Hub-Signature-256).
  WA_APP_SECRET: process.env.WA_APP_SECRET || '',
  // Versión de la Graph API.
  GRAPH_VERSION: process.env.GRAPH_VERSION || 'v25.0',

  // --- WhatsApp (Baileys, legado — ya no se usa con Cloud API) ---
  PAIRING_NUMBER: (process.env.PAIRING_NUMBER || '').replace(/\D/g, ''),
  AUTH_SEED_B64: process.env.AUTH_SEED_B64 || '',

  // --- Avisos al dueño ---
  // Preferido: Telegram (canal interno; NO depende de la ventana de 24h de WhatsApp
  // ni viola las reglas de Cloud API). Reutiliza el bot de la Ficha de alta.
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  // Fallback WhatsApp (solo llega dentro de la ventana de 24h; dejalo vacío si usás Telegram).
  OWNER_NUMBER: (process.env.OWNER_NUMBER || '').replace(/\D/g, ''),

  // --- Persistencia ---
  DATA_DIR: process.env.DATA_DIR || '.',

  // --- Devolucion de la venta a Meta (API de Conversiones) -----------------
  // Cierra el circuito: cuando el vendedor del cliente marca una consulta como
  // ganada, se le devuelve el evento a Meta con su valor para que la campana
  // optimice hacia compradores y no hacia leads baratos. Ver src/conversiones.js
  // y la spec de medición §6.6. Sin DATASET_ID + ACCESS_TOKEN el lote corre igual pero
  // solo en modo de prueba: arma el payload y no lo manda.
  META_DATASET_ID: process.env.META_DATASET_ID || '',
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || '',
  // Identificador de la cuenta de WhatsApp Business. Para mensajeria Meta pide
  // el WABA, no page_id (page_id es de Messenger e Instagram). Si el bot ya lo
  // tiene cargado, se reusa.
  META_WABA_ID: process.env.META_WABA_ID || process.env.WABA_ID || '',
  // Version de Graph para los eventos. Se separa de la del bot por si hay que
  // moverlas en momentos distintos.
  META_GRAPH_VERSION: process.env.META_GRAPH_VERSION || process.env.GRAPH_VERSION || 'v25.0',
  // Override del endpoint de eventos. Vacio en produccion. Sirve para probar el
  // circuito completo contra un servidor local sin credenciales, y por si hay
  // que salir por un proxy.
  META_EVENTS_URL: process.env.META_EVENTS_URL || '',
  // Codigo de "Eventos de prueba" del Administrador de eventos: manda los
  // eventos al tablero de prueba en vez de a los datos reales. Vacio en prod.
  META_TEST_EVENT_CODE: process.env.META_TEST_EVENT_CODE || '',
  // Con que nombre figura la integracion del lado de Meta.
  META_PARTNER_AGENT: process.env.META_PARTNER_AGENT || 'whatsapp-ai-sales-agent',
  // Moneda por defecto de los montos declarados.
  META_CURRENCY: process.env.META_CURRENCY || 'ARS',
  // Que evento se devuelve cuando una fila pasa a ganado.
  META_EVENT_NAME: process.env.META_EVENT_NAME || 'Purchase',
  // Mandar el telefono hasheado (SHA-256) adentro del evento. Apagado: el
  // ctwa_clid ya alcanza para atribuir y mandar datos personales que no suman
  // es regalar superficie.
  META_ENVIAR_TELEFONO: process.env.META_ENVIAR_TELEFONO === '1',
  // Mandar la venta aunque el vendedor no haya declarado el monto. Apagado: la
  // doc pide value + currency para Purchase, y un monto inventado es peor que
  // no mandar nada.
  META_ENVIAR_SIN_VALOR: process.env.META_ENVIAR_SIN_VALOR === '1',
  // Cuenta publicitaria (act_...). Solo la usa la reconciliacion, para traer lo
  // que informa Meta y ponerlo al lado de lo que dice el registro.
  META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID || '',
  // Archivo local de ventas declaradas (alternativa a la planilla, y lo que
  // permite probar el circuito sin credenciales de Google).
  VENTAS_FILE: process.env.VENTAS_FILE || '',
  // Pestana de la planilla donde estan las columnas del Grupo B. Por defecto,
  // la misma del CRM.
  VENTAS_SHEET_TAB: process.env.VENTAS_SHEET_TAB || '',

  // --- Interruptores ---
  BOT_PAUSED: process.env.BOT_PAUSED === '1',
  // Análisis IA por lead (estilo/objeción/temperatura). 1 llamada extra a Claude
  // por turno. Poné INSIGHTS=0 para apagarlo.
  INSIGHTS: process.env.INSIGHTS !== '0',
  // Recordatorios anti no-show (24h y 1h antes de la llamada). REMINDERS=0 apaga.
  REMINDERS: process.env.REMINDERS !== '0',
  // Transcripción de audios (Google Speech-to-Text). STT=1 activa. Requiere la
  // API habilitada + billing en GCP. Si falla, el bot pide el texto (no crashea).
  STT: process.env.STT === '1',
  // Opener personalizado al anuncio cuando el lead llega de Click-to-WhatsApp.
  // PERSONALIZED_OPENER=0 vuelve al opener fijo del A/B.
  PERSONALIZED_OPENER: process.env.PERSONALIZED_OPENER !== '0',
  // SOLO enganchar leads que vengan de un anuncio (Click-to-WhatsApp). 1/on por
  // default: si alguien escribe sin venir de un aviso de Meta, el bot lo IGNORA
  // (no crea lead, no responde). AD_ONLY=0 lo abre a cualquiera que escriba.
  AD_ONLY: process.env.AD_ONLY !== '0',

  // Modo testing: pone TODAS las pausas (opener, visto, respuesta, globos) en 0 para
  // probar rápido. INSTANT=1 lo activa; para producción dejarlo en 0/sin setear.
  INSTANT: process.env.INSTANT === '1',
  // Clave secreta para el panel web de conversaciones (/panel?k=...). Vacío = panel apagado.
  PANEL_KEY: process.env.PANEL_KEY || '',

  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  // Tope de turnos del loop de tools por mensaje (anti-bucle infinito)
  MAX_TOOL_TURNS: num(process.env.MAX_TOOL_TURNS, 6),
  // Override del delay del primer mensaje (segundos). Vacío = usa SETTINGS.openerDelaySeg.
  // Útil para testear sin esperar 5 min (ej. OPENER_DELAY_SEG=15).
  OPENER_DELAY_SEG: process.env.OPENER_DELAY_SEG ? num(process.env.OPENER_DELAY_SEG, 300) : null,

  // --- Monitoreo de salud (/salud) y avisos por Telegram cuando algo se rompe ---
  // Reutiliza el mismo bot/chat de Telegram de más arriba (TELEGRAM_BOT_TOKEN /
  // TELEGRAM_CHAT_ID): si faltan, src/alerts.js no manda nada pero el bot arranca
  // igual (una alerta rota nunca puede tirar abajo el bot que vigila).
  //
  // Umbral del aviso de "silencio raro": horas HÁBILES seguidas sin un solo
  // mensaje entrante antes de avisar. Solo cuenta lunes a viernes de 9 a 21 (hora
  // de TIMEZONE) — de noche y los fines de semana no entran leads y no es señal
  // de nada roto, así que no suman para este umbral.
  SILENCE_HOURS: num(process.env.SILENCE_HOURS, 3),
  SILENCE_START_HOUR: num(process.env.SILENCE_START_HOUR, 9),
  SILENCE_END_HOUR: num(process.env.SILENCE_END_HOUR, 21),
  // El aviso de silencio solo dispara si hubo al menos un lead de un anuncio en
  // esta ventana (evidencia de que hay campañas corriendo). Si nunca entró un
  // lead de anuncio, o hace más de esto que no entra ninguno, no hay forma de
  // saber si las campañas siguen activas o las pausó el propio Martín: en
  // ese caso preferimos callarnos antes que mandar un falso positivo.
  CAMPAIGN_LOOKBACK_DAYS: num(process.env.CAMPAIGN_LOOKBACK_DAYS, 7),
  // Minutos sin la PRIMERA respuesta a un lead nuevo antes de avisar (aviso
  // "lead sin responder"). El opener normal sale a los 2-5 min; 15 da margen de
  // sobra para el delay humano sin tardar en detectar un cuelgue real.
  UNANSWERED_MIN: num(process.env.UNANSWERED_MIN, 15),
  // Horas HÁBILES que el bot puede estar arriba SIN HABER RECIBIDO NUNCA NI UN
  // SOLO MENSAJE antes de avisar (aviso aparte del de silencio: ver el comentario
  // en health.js sobre por qué el criterio es al revés cuando no hay historial).
  // 1h alcanza para no sonar en un redeploy común y sirve el día del lanzamiento.
  NEVER_RECEIVED_HOURS: num(process.env.NEVER_RECEIVED_HOURS, 1),
};
