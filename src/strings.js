/** Textos ES/EN — alineados con data/traducciones.json */

export const I18N = {
  es: {
    nav: {
      home: "Inicio",
      calc: "Calculadora",
      trade: "Comparador",
      scanner: "Scanner",
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
      scanner_desc: "Herramienta de escaneo — disponible pronto.",
    },
    scanner: {
      kicker: "TD HUB",
      title: "Scanner",
      coming: "Próximamente",
      wip: "En construcción",
      live_build: "Obra en curso",
      countdown_target: "Martes 5 may 2026 · 20:00 (hora peninsular)",
      countdown_heading: "Cuenta atrás",
      countdown_done: "¡Llegó la hora!",
      cd_days: "Días",
      cd_hours: "Horas",
      cd_minutes: "Min",
      cd_seconds: "Seg",
    },
    calc: {
      title: "Calculadora de valor",
      search: "Buscar unidad…",
      total: "Valor total",
      clear_all: "Limpiar todo",
      reopen: "Elegir votos…",
      close: "Cerrar",
    },
    trade: {
      title: "Comparador de trade",
      search: "Buscar…",
      clear: "Limpiar todo",
      didactic_intro:
        "Arriba en cada columna verás el inventario que vas formando en el trade. Abajo está el buscador y los controles para añadir o quitar unidades.",
      stock_you: "Tu inventario en el trade",
      stock_opponent: "Inventario del rival",
      stock_empty:
        "Aún sin unidades. Pulsa + en las filas de abajo para incorporarlas a este lado.",
      picker_caption: "Unidades disponibles · + / −",
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
      scanner: "Scanner",
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
      scanner_desc: "Scanning tool — coming soon.",
    },
    scanner: {
      kicker: "TD HUB",
      title: "Scanner",
      coming: "Coming soon",
      wip: "Under construction",
      live_build: "Work in progress",
      countdown_target: "Tue May 5, 2026 · 8:00 PM (Spain mainland)",
      countdown_heading: "Countdown",
      countdown_done: "It's time!",
      cd_days: "Days",
      cd_hours: "Hours",
      cd_minutes: "Min",
      cd_seconds: "Sec",
    },
    calc: {
      title: "Value calculator",
      search: "Search unit…",
      total: "Total value",
      clear_all: "Clear all",
      reopen: "Choose votes…",
      close: "Close",
    },
    trade: {
      title: "Trade comparison",
      search: "Search…",
      clear: "Clear all",
      didactic_intro:
        "Each column shows the inventory you’re building for that side. Below you can search and use + / − to add units to the trade.",
      stock_you: "Your inventory in this trade",
      stock_opponent: "Opponent’s inventory",
      stock_empty:
        "Nothing here yet — use + in the rows below to add units to this side.",
      picker_caption: "Available units · + / −",
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
