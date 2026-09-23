export const LOCALES = {
  ru: {
    brand: 'AML Desk',
    brandSub: 'Граф денег',
    searchPlaceholder: 'Поиск клиента по идентификационному номеру',
    searchBtn: 'Найти',
    navNetwork: 'Network',
    navHunt: 'Hunt',
    navPriority: 'Priority',
    period: 'Июль 2026',
    periodJul: 'Июл',
    periodAug: 'Авг',
    avatarTitle: 'AML аналитик',
    loading: 'Freedom Bank · загрузка графа…',
    loadError: 'Нет graph.json — запусти python pipeline.py',
    notFound: (q) => `Клиент не найден: ${q}`,

    sideHead: 'Роли в сети',
    allNetwork: 'Вся сеть',
    allNetworkHint: 'полный срез',
    nodesUnit: 'узлов',

    roles: {
      consolidator: 'Точки сбора',
      coordinator: 'Организаторы',
      distributor: 'Распределители',
      transit: 'Транзит',
      terminal: 'Конечные',
      peripheral: 'Периферия',
    },
    roleHints: {
      consolidator: 'сбор средств',
      coordinator: 'управление схемой',
      distributor: 'веерная раздача',
      transit: 'проход без удержания',
      terminal: 'деньги оседают',
      peripheral: 'без яркой роли',
    },
    roleTooltips: {
      consolidator: 'Клиенты, которые аккумулируют средства от нескольких участников сети',
      coordinator: 'Кандидаты в организаторы — управляют потоками между узлами',
      distributor: 'Раздают полученные средства дальше по схеме',
      transit: 'Пропускают деньги дальше почти без остатка на счёте',
      terminal: 'Конечные получатели — средства у них оседают',
      peripheral: 'Участники без выраженной роли в структуре группы',
    },

    graphShown: (nodes, links) =>
      `Показано ${nodes} узлов · ${links} связей`,
    collapsedBranch: (n) => `ещё ${n}`,
    expandBranch: 'Развернуть',

    clientCard: 'Карточка клиента',
    clientEmpty: 'Кликните узел на графе или строку в топе',
    seed: 'seed',
    depth: 'глубина',
    cluster: 'кластер',
    received: 'Получил',
    sent: 'Отправил',
    balance: 'Сальдо в графе',
    payers: (n) => `${n} плательщиков`,
    recipients: (n) => `${n} получателей`,
    txPriority: (tx, p) => `${tx} tx · priority ${p}`,

    txHistory: 'История переводов',
    txCount: (n) => `${n} шт.`,
    txEmpty: 'Нет транзакций в выгрузке',
    colDate: 'Дата',
    colType: 'Тип',
    colCounterparty: 'Контрагент',
    colAmount: 'Сумма',
    txIn: '↓ вход',
    txOut: '↑ выход',

    linkAgg: 'Агрегат по связям',

    priorityRank: 'Priority ranking',
    prioritySub: 'кого смотреть первым',
    colRank: '#',
    colClient: 'Client',
    colScore: 'Score',
    colDelta: 'Δ',

    slice: 'Срез:',
    langRu: 'RU',
    langEn: 'EN',
  },

  en: {
    brand: 'AML Desk',
    brandSub: 'Money Graph',
    searchPlaceholder: 'Search client by identification number',
    searchBtn: 'Search',
    navNetwork: 'Network',
    navHunt: 'Hunt',
    navPriority: 'Priority',
    period: 'July 2026',
    periodJul: 'Jul',
    periodAug: 'Aug',
    avatarTitle: 'AML analyst',
    loading: 'Freedom Bank · loading graph…',
    loadError: 'Missing graph.json — run python pipeline.py',
    notFound: (q) => `Client not found: ${q}`,

    sideHead: 'Network roles',
    allNetwork: 'Full network',
    allNetworkHint: 'complete slice',
    nodesUnit: 'nodes',

    roles: {
      consolidator: 'Collection hubs',
      coordinator: 'Organizers',
      distributor: 'Distributors',
      transit: 'Transit',
      terminal: 'Terminals',
      peripheral: 'Peripheral',
    },
    roleHints: {
      consolidator: 'funds accumulate',
      coordinator: 'scheme control',
      distributor: 'fan-out payouts',
      transit: 'pass-through',
      terminal: 'funds settle',
      peripheral: 'no clear role',
    },
    roleTooltips: {
      consolidator: 'Clients who accumulate funds from multiple network participants',
      coordinator: 'Likely organizers — control flows between nodes',
      distributor: 'Spread received funds further through the scheme',
      transit: 'Pass money onward with little retained balance',
      terminal: 'End recipients where funds settle',
      peripheral: 'Participants without a distinct role in the group structure',
    },

    graphShown: (nodes, links) =>
      `Showing ${nodes} nodes · ${links} links`,
    collapsedBranch: (n) => `+${n} more`,
    expandBranch: 'Expand',

    clientCard: 'Client card',
    clientEmpty: 'Click a graph node or a row in the ranking',
    seed: 'seed',
    depth: 'depth',
    cluster: 'cluster',
    received: 'Received',
    sent: 'Sent',
    balance: 'Balance in graph',
    payers: (n) => `${n} payers`,
    recipients: (n) => `${n} recipients`,
    txPriority: (tx, p) => `${tx} tx · priority ${p}`,

    txHistory: 'Transfer history',
    txCount: (n) => `${n}`,
    txEmpty: 'No transactions in the export',
    colDate: 'Date',
    colType: 'Type',
    colCounterparty: 'Counterparty',
    colAmount: 'Amount',
    txIn: '↓ in',
    txOut: '↑ out',

    linkAgg: 'Link aggregates',

    priorityRank: 'Priority ranking',
    prioritySub: 'who to review first',
    colRank: '#',
    colClient: 'Client',
    colScore: 'Score',
    colDelta: 'Δ',

    slice: 'Slice:',
    langRu: 'RU',
    langEn: 'EN',
  },
}

export function t(locale, key, ...args) {
  const dict = LOCALES[locale] || LOCALES.ru
  const val = key.split('.').reduce((o, k) => (o == null ? o : o[k]), dict)
  if (typeof val === 'function') return val(...args)
  return val ?? key
}
