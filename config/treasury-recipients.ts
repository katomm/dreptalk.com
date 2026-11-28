// Curated labels for treasury recipient addresses, mainnet only. An entry is
// allowed only when the proposer named this exact address in the text of a
// governance action and said what it is. The label keeps the proposer's words
// (person names left out), sourceQuote is copied verbatim from that action and
// contains the address or hash, so a typo in the hash fails the config test.
// Evidence: claude-notes dreptalk/2026-11-28-treasury-recipient-labels-research.

export interface RecipientLabel {
  credType: 'keyHash' | 'scriptHash';
  hash: string;
  label: string;
  sourceActionId: string;
  sourceQuote: string;
}

export const RECIPIENT_LABELS: readonly RecipientLabel[] = [
  {
    credType: 'scriptHash',
    hash: '8583857e4a12ffe1e6f641a1785a0f2f036c565cfbe6ff9db8e5a469',
    label: 'Intersect 2025 treasury reserve contract',
    sourceActionId: '17e43ffe4b2e0df1787d54f21ac66643c74abb131a326272fceecbdbbdd0d3fc#0',
    sourceQuote:
      'This withdrawal will utilise Intersect’s 2025 treasury reserve contract with address being: stake17xzc8pt7fgf0lc0x7eq6z7z6puhsxmzktna7dluahrj6g6ghh5qjr',
  },
  {
    credType: 'scriptHash',
    hash: 'eb06997a94b339ee0b0dd0de7bfec2a184d1af577586654d44e90558',
    label: 'Intersect 2026 treasury reserve contract',
    sourceActionId: 'b3d452bff7769d7f557ec6b8974760ee6c5e496c276652b654032966621e0ccf#1',
    sourceQuote:
      'The 2026 Treasury Reserve Smart Contract stake address: stake1784sdxt6jjennmstphgdu7l7c2scf5d02a6cve2dgn5s2kq5u3j9v',
  },
  {
    credType: 'scriptHash',
    hash: 'a7966878550ce11ec8a83b93fc1a6e105d544f78494401066c4fe0cf',
    label: 'Amaru 2025 treasury, ledger and overall architecture',
    sourceActionId: '60ed6ab43c840ff888a8af30a1ed27b41e9f4a91a89822b2b63d1bfc52aeec45#0',
    sourceQuote:
      'responsible for the ledger & overall architecture with a budget of 1.5 FTEs ( ₳300,000 ) until end of 2025. Managing treasury at: stake17xnev6rc25xwz8kg4qae8lq6dcg964z00py5gqgxd387pncv8fq8g',
  },
  {
    credType: 'scriptHash',
    hash: '9beae6fc7feada6ccf824554b5e3a498eab15205ac9248c3fb993b5f',
    label: 'Amaru 2025 treasury, consensus and simulation testing',
    sourceActionId: '60ed6ab43c840ff888a8af30a1ed27b41e9f4a91a89822b2b63d1bfc52aeec45#0',
    sourceQuote:
      'responsible for the consensus and simulation testing , with a budget of 1.5 FTEs ( ₳300,000 ) until end of 2025. Managing treasury at: stake17xd74ehu0l4d5mx0sfz4fd0r5jvw4v2jqkkfyjxrlwvnkhccrqj9l',
  },
  {
    credType: 'scriptHash',
    hash: '877f57e0bdcc8167e984dee052d8dd7346effc08ff80a29b045e1a10',
    label: 'Amaru 2025 treasury, ad hoc work and middleware integrations',
    sourceActionId: '60ed6ab43c840ff888a8af30a1ed27b41e9f4a91a89822b2b63d1bfc52aeec45#0',
    sourceQuote:
      'responsible for the ad hoc work and middleware integrations (a.k.a mercenaries) with a budget of 2.5 FTEs ( ₳500,000 ) until end of 2025. Managing treasury at: stake17xrh74lqhhxgzelfsn0wq5kcm4e5dmluprlcpg5mq30p5yqhgk7k8',
  },
  {
    credType: 'scriptHash',
    hash: '860ee0f6bd8235842a908afd86dc949c4c9dabd74b0965c364b8d315',
    label: 'Amaru 2025 treasury, project management, public relations and marketing',
    sourceActionId: '60ed6ab43c840ff888a8af30a1ed27b41e9f4a91a89822b2b63d1bfc52aeec45#0',
    sourceQuote:
      'responsible for the project management, public relations & marketing with a budget of 0.5 FTE ( ₳100,000 ) until end of 2025. Managing treasury at: stake17xrqac8khkprtpp2jz90mpkujjwye8dt6a9sjewrvjudx9ggg4u5y',
  },
  {
    credType: 'scriptHash',
    hash: 'e425984e24fb2c06ad676882178ddee6e47b994a589ae3d70c817c79',
    label: 'Amaru 2025 contingency treasury',
    sourceActionId: '60ed6ab43c840ff888a8af30a1ed27b41e9f4a91a89822b2b63d1bfc52aeec45#0',
    sourceQuote: "The contingency treasury's stake address is: stake178jztxzwynajcp4dva5gy9udmmnwg7ueffvf4c7hpjqhc7gtj5nzz",
  },
  {
    credType: 'scriptHash',
    hash: '5f8a75f7881d630399bd9a8f5758c77b1bb522407d8b1b4e13421f7c',
    label: 'Dingo treasury contract (Blink Labs)',
    sourceActionId: 'f35285db3c4e085ad331843b3007737952b8a322bb3216311edc37fdf44ad3da#0',
    sourceQuote:
      '"label":"Treasury Contract Script Hash","uri":"https://cardanoscan.io/scriptHash/5f8a75f7881d630399bd9a8f5758c77b1bb522407d8b1b4e13421f7c"',
  },
  {
    credType: 'scriptHash',
    hash: '36727b0880a8f76304647ce1b21c52c53a111426698c064abcc2ca86',
    label: 'Mesh multisig wallet',
    sourceActionId: '6b40978780eb15f44786329b39c947f5ff37162464ec4947dcffb55d9139adc7#0',
    sourceQuote:
      'Multisig wallet address. addr1x8lfcemwae3x3fmjjj7z6lry8thvlttr6f94epwgtf8w7k3kwfas3q9g7a3sgeruuxepc5k98gg3gfnf3sry40xze2rqcfp5te Stake address (receives the withdrawal). stake17ym8y7cgsz50wccyv37wrvsu2tzn5yg5ye5ccpj2hnpv4pse6q7jk',
  },
  {
    credType: 'keyHash',
    hash: 'b6914e1047d69e76c6fff866e71be15ce6d4f673c22782fc474c4911',
    label: 'Toto Finance receiving address',
    sourceActionId: '6eddf4f1dbad06f329aa69743559c4930b7b689f16c073061d228d9c6613d19c#0',
    sourceQuote: 'The receiving mainnet reward address is stake1uxmfznssgltfuakxlluxdecmu9wwd48kw0pz0qhugaxyjyguc0tax',
  },
];
