# openapi-log-mapper

Ferramenta técnica para:

- mapear logs XML/SOAP para operações OpenAPI
- explorar catálogo de APIs via CSV
- gerar cURL com headers/body mapeados
- converter OpenAPI para Postman Collection

## Funcionalidades principais

### 1) Gerador cURL
- valida spec OpenAPI (YAML/JSON)
- sugere automaticamente operação com score/confiança
- extrai sinais do log (namespace, service, entidades, headers)
- prepara mapeamento XML -> JSON com edição manual
- mantém histórico local de specs/XML validados
- gera cURL final pronto a copiar

### 2) Pesquisa CSV
- carrega CSV de catálogo (por defeito: `proxies_catalog_apigee2.csv`)
- pesquisa e agrupamento (target/method/base path)
- detalhe da operação em painel lateral
- consolidação visual de entradas duplicadas (ex.: `public` + `private`)
- geração de links de documentação/YAML conforme plataforma

### 3) OpenAPI -> Postman
- valida OpenAPI
- corrige problemas básicos de YAML
- gera Postman Collection
- permite copiar/exportar JSON

## Stack

- React 18 (UMD no `openapi-toolbox.html` + app Vite em `src/`)
- Tailwind CSS
- Highlight.js
- js-yaml

## Estrutura relevante

- `openapi-toolbox.html`: versão standalone principal (UI completa num único ficheiro)
- `src/App.jsx`: versão modular React/Vite
- `proxies_catalog_apigee2.csv`: catálogo CSV mais recente
- `default-csv-data.js`: fallback embutido do CSV
- `tests/core-utils.test.js`: testes unitários de utilitários

## Como executar

### Opção A: Vite (desenvolvimento)
```bash
npm install
npm run dev
```

### Opção B: standalone
Abrir `openapi-toolbox.html` no browser.

## Scripts

```bash
npm run dev
npm run build
npm run test
npm run preview
```

## Formato CSV esperado

Cabeçalho canónico:

`Method;Path;Version;Target Name;Target Path;Target Service;Name;Platform;Network;STATUS`

## Licença

MIT (ver `LICENSE`).
