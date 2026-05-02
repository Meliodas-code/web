/** Textos ES/EN — alineados con data/traducciones.json */

export const I18N = {
  es: {
    nav: {
      home: "Inicio",
      calc: "Calculadora",
      trade: "Comparador",
      credits: "Créditos",
    },
    main: {
      bienvenida: "BIENVENIDO A TD HUB",
      home_subtitle:
        "Usa datos en la nube. Despliegue gratis con GitHub Pages u otro hosting estático.",
      home_badge: "Versión web",
      open: "Abrir",
      calc_desc: "Calcula valor con varios votos por unidad.",
      trade_desc: "Compara dos ofertas lado a lado.",
    },
    calc: {
      title: "Calculadora de valor",
      search: "Buscar unidad…",
      total: "Valor total",
      reopen: "Elegir votos…",
      close: "Cerrar",
    },
    trade: {
      title: "Comparador de trade",
      search: "Buscar…",
      clear: "Limpiar todo",
      left: "Tu oferta",
      right: "Oferta rival",
      left_tot: "Total izquierda",
      right_tot: "Total derecha",
      diff: "Diferencia",
      fair: "Equilibrado",
      win_left: "Gana izquierda",
      win_right: "Gana derecha",
      modal_title: "Votos por unidad",
      side_left: "(izquierda)",
      side_right: "(derecha)",
      value: "Valor",
    },
    credits: {
      title: "Créditos",
      line1: "Web y lógica: derivada del proyecto TD HUB escritorio.",
      line2:
        'Datos: Supabase — configura tus claves públicas anon en archivo .env (ver plantilla ".env.example").',
    },
  },
  en: {
    nav: {
      home: "Home",
      calc: "Calculator",
      trade: "Trade",
      credits: "Credits",
    },
    main: {
      bienvenida: "WELCOME TO TD HUB",
      home_subtitle:
        "Cloud-backed data. Free deploy on GitHub Pages or any static host.",
      home_badge: "Web build",
      open: "Open",
      calc_desc: "Calculate value with multiple votes per unit.",
      trade_desc: "Compare both offers side by side.",
    },
    calc: {
      title: "Value calculator",
      search: "Search unit…",
      total: "Total value",
      reopen: "Choose votes…",
      close: "Close",
    },
    trade: {
      title: "Trade comparison",
      search: "Search…",
      clear: "Clear all",
      left: "Your offer",
      right: "Opponent offer",
      left_tot: "Left total",
      right_tot: "Right total",
      diff: "Difference",
      fair: "Fair",
      win_left: "Left wins",
      win_right: "Right wins",
      modal_title: "Votes per unit",
      side_left: "(left)",
      side_right: "(right)",
      value: "Value",
    },
    credits: {
      title: "Credits",
      line1: "Web app: ported from TD HUB desktop.",
      line2:
        'Data: Supabase — set anon keys in `.env` (see ".env.example").',
    },
  },
};

export function t(lang, path) {
  const parts = path.split(".");
  let cur = I18N[lang] ?? I18N.es;
  for (const p of parts) cur = cur?.[p];
  return typeof cur === "string" ? cur : path;
}
