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
      list_values_thanks:
        "Agradecemos al equipo de Sorcerer TD Value List por los valores de referencia que hacen posible esta calculadora.",
      official_list_link: "Documento oficial de la lista (Google Sheets)",
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
      title: "CRÉDITOS",
      hecho_por: "Hecho por: @meliodas_000.",
      idea: "Idea propuesta por: @Toropapita",
      database: "Base de datos: @Toropapita",
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
      list_values_thanks:
        "Thanks to the Sorcerer TD Value List team for the reference values that power this calculator.",
      official_list_link: "Official value list spreadsheet (Google Sheets)",
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
      title: "CREDITS",
      hecho_por: "Made by: @meliodas_000.",
      idea: "Idea proposed by: @Toropapita",
      database: "Database: @Toropapita",
    },
  },
};

export function t(lang, path) {
  const parts = path.split(".");
  let cur = I18N[lang] ?? I18N.es;
  for (const p of parts) cur = cur?.[p];
  return typeof cur === "string" ? cur : path;
}
