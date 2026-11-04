# Bora Marcar 🎉

Site para escolher a data da confraternização. O organizador cria um evento e manda o link no grupo do WhatsApp. Cada pessoa entra com o telefone, escolhe se vai marcar os dias que **pode** ou os dias que **não pode**, e toca no calendário. O site calcula, para cada dia, quantas pessoas podem ir e mostra o ranking das melhores datas.

Tudo roda de graça: Firebase (banco de dados e login) + hospedagem gratuita (Netlify ou Firebase Hosting).

## Antes de tudo: testar sem configurar nada

Do jeito que está (com `firebase: null` no `config.js`), o site abre em **modo demonstração**: os dados ficam só no seu navegador e o código de login é sempre `123456`. Na aba **Gerenciar** existe um botão para adicionar participantes fictícios e ver o cálculo funcionando.

## Quanto custa o login por SMS?

| Opção | Como a pessoa entra | Custo |
|---|---|---|
| `authMode: "sms"` | Recebe um código por SMS | O Firebase exige o plano **Blaze** (cadastrar um cartão). Os **10 primeiros SMS de cada dia são grátis**; depois disso, cerca de US$ 0,02 por SMS no Brasil. Um grupo de 30 pessoas custa no máximo uns R$ 2, e cada pessoa só recebe o código uma vez por aparelho. |
| `authMode: "simples"` | Digita nome e telefone, sem código | **R$ 0**, plano gratuito (Spark), sem cartão. Como o link só circula no grupo, normalmente é suficiente. |

O site vem no modo `"simples"`. Para usar SMS, troque para `"sms"` no `config.js`.

## Passo a passo (uns 15 minutos)

### 1. Criar o projeto no Firebase
1. Acesse https://console.firebase.google.com e clique em **Criar projeto** (pode desativar o Google Analytics).
2. Na página do projeto, clique no ícone **Web `</>`** para registrar um app. Dê um nome qualquer e **não** marque o Hosting por enquanto.
3. O Firebase mostra um bloco `const firebaseConfig = { ... }`. Copie o conteúdo entre as chaves e cole no `config.js`, no lugar de `firebase: null`:
   ```js
   firebase: {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "...",
   },
   ```

### 2. Criar o banco de dados
1. No menu, vá em **Firestore Database → Criar banco de dados**.
2. Escolha a região `southamerica-east1 (São Paulo)` e o **modo de produção**.
3. Abra a aba **Regras**, apague o que estiver lá, cole o conteúdo do arquivo `firestore.rules` e clique em **Publicar**.

### 3. Ativar o login
Vá em **Authentication → Começar → Método de login** e escolha uma das opções:

**Opção A: login por SMS** (mude para `authMode: "sms"` no `config.js`)
1. Ative o provedor **Telefone**.
2. No canto inferior esquerdo, clique em **Fazer upgrade** e escolha o plano **Blaze** (pede um cartão).
3. Recomendado para não ter surpresa:
   - Em https://console.cloud.google.com/billing, abra **Orçamentos e alertas** e crie um alerta de, por exemplo, R$ 10.
   - Em **Authentication → Configurações → Política de região de SMS**, permita só o **Brasil** (evita fraudes de SMS para outros países).
4. Para testar sem gastar SMS: em **Telefone → Números de telefone para teste**, cadastre um número fictício com um código fixo.

**Opção B: 100% grátis, sem código** (já é o padrão: `authMode: "simples"` no `config.js`)
1. Ative o provedor **Anônimo**. Pronto, não precisa de cartão.

### 4. Publicar o site (grátis)

**Vercel (pelo GitHub)**
1. Entre em https://vercel.com/new com a sua conta do GitHub.
2. Escolha o repositório `confra-facil` e clique em **Deploy** (não precisa mudar nada).
3. O site fica em algo como `https://confra-facil.vercel.app`. Cada alteração no GitHub publica de novo automaticamente.

**Alternativa: Netlify Drop**
1. Acesse https://app.netlify.com/drop e crie uma conta grátis.
2. Arraste a pasta `confra-facil` inteira para a página.
3. Em segundos você recebe um endereço como `https://nome-aleatorio.netlify.app`. Dá para trocar o nome em **Site configuration → Change site name**.

**Alternativa: Firebase Hosting** (precisa do Node.js instalado)
```bash
npm install -g firebase-tools
firebase login
cd confra-facil
firebase use --add      # escolha o seu projeto
firebase deploy         # publica o site e as regras do banco
```
O site fica em `https://SEU-PROJETO.web.app`.

### 5. Autorizar o endereço do site
Em **Authentication → Configurações → Domínios autorizados**, clique em **Adicionar domínio** e coloque o endereço do site (ex.: `confra-facil.vercel.app`). O domínio do Firebase Hosting já vem autorizado.

## Como usar
1. Abra o site, entre com o seu telefone e informe seu nome.
2. Em **Criar novo evento**, dê um nome, escolha o período e os dias da semana possíveis (por exemplo, só sexta e sábado).
3. Na aba **Gerenciar**, toque em **Enviar no WhatsApp** e escolha o grupo.
4. Acompanhe a aba **Resultado**: o ranking mostra quantas pessoas podem em cada dia e quem não pode.
5. Quando todos responderem, escolha a data em **Definir a data final**. A votação é encerrada e você pode avisar o grupo com um toque.

## Como o cálculo funciona
- Quem marcou os dias que **pode**: conta como disponível só nesses dias.
- Quem marcou os dias que **não pode**: conta como disponível em todos os outros dias do período.
- Para cada dia em votação, o site soma quantas pessoas estão disponíveis. O dia com mais gente fica em primeiro. Se houver empate, todas as datas empatadas aparecem como melhores, e você escolhe.

## Arquivos
| Arquivo | Para que serve |
|---|---|
| `index.html`, `style.css`, `app.js` | O site |
| `config.js` | **O único arquivo que você precisa editar** |
| `firebase-backend.js` | Conexão com o Firebase |
| `demo-backend.js` | Modo demonstração (sem Firebase) |
| `firestore.rules` | Regras de segurança do banco |
| `firebase.json` | Configuração do Firebase Hosting |

## Proteção contra robôs (opcional)
1. Acesse https://www.google.com/recaptcha/admin/create, escolha **reCAPTCHA v3** e adicione o domínio do site (ex.: `confra-facil.vercel.app`). Copie a **chave do site** e a **chave secreta**.
2. No Firebase, abra **Segurança → App Check**, escolha o app Web, selecione **reCAPTCHA** e cole a **chave secreta**.
3. Cole a **chave do site** em `appCheckSiteKey` no `config.js` e publique.
4. Depois de um ou dois dias vendo as métricas no App Check, ative **Aplicar** para o Firestore e o Authentication.
