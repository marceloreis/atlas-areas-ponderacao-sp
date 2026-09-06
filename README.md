# Atlas das Áreas de Ponderação de São Paulo

Mapa interativo das 2.535 Áreas de Ponderação do estado de São Paulo, com 31 tabelas dos Resultados Gerais da Amostra do Censo Demográfico 2022. A geometria e os dados censitários são associados pelo código da Área de Ponderação (`cd_apond`).

## Funcionalidades

- consulta por código ou nome da Área de Ponderação;
- mapa temático para qualquer uma das 305 variáveis disponíveis;
- seleção direta das áreas no mapa;
- painel com os indicadores da área selecionada;
- legenda, escala de cores e informação sobre dados ausentes;
- interface responsiva para computador e dispositivos móveis.

## Estrutura do projeto

- `dist/`: site pronto para publicação;
- `dist/data/*.manifest.json`: manifestos dos conjuntos de dados;
- `dist/data/*.part-*`: partes das geometrias e dos indicadores censitários;
- `scripts/build_data.py`: rotina de preparação e otimização dos dados;
- `.github/workflows/pages.yml`: publicação automática no GitHub Pages.

O site usa HTML, CSS, JavaScript e Leaflet 1.9.4. As dependências necessárias à execução estão incluídas em `dist`, portanto o navegador não depende de CDN, serviço de mapas-base ou API externa. A cartografia vetorial foi simplificada e os conjuntos de dados foram divididos em partes menores para tornar o carregamento mais resiliente. O botão **Baixar GeoJSON** remonta e entrega o arquivo completo no navegador.

## Executar localmente

Como os arquivos de dados são carregados por `fetch`, abra o projeto por um servidor HTTP local:

```bash
python3 -m http.server 8000 --directory dist
```

Depois acesse <http://localhost:8000>.

## Publicação

Todo envio para a branch `main` aciona o workflow de publicação da pasta `dist` no GitHub Pages. Também é possível executá-lo manualmente pela aba **Actions** do repositório.

## Fontes e licenças de terceiros

- Dados: IBGE, Censo Demográfico 2022 — Resultados Gerais da Amostra.
- Geometrias: IBGE, Áreas de Ponderação 2022 do estado de São Paulo.
- Sistema de referência na fonte: SIRGAS 2000; distribuição web em GeoJSON (CRS84).
- Leaflet é distribuído sob licença BSD-2-Clause; o texto está em `dist/vendor/leaflet/LICENSE`.

Há 15 feições territoriais sem linha correspondente nas tabelas censitárias fornecidas; elas permanecem visíveis no mapa e são sinalizadas como sem dados.
