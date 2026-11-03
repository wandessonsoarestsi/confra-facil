// Configuração do Confra Fácil
// Veja o LEIA-ME.md para o passo a passo.

export const CONFIG = {
  // Cole aqui o objeto "firebaseConfig" do seu projeto Firebase.
  // Enquanto estiver null, o site roda em MODO DEMONSTRAÇÃO
  // (dados salvos só no navegador, código de login sempre 123456).
  //
  // Exemplo:
  // firebase: {
  //   apiKey: "AIza...",
  //   authDomain: "minha-confra.firebaseapp.com",
  //   projectId: "minha-confra",
  //   storageBucket: "minha-confra.appspot.com",
  //   messagingSenderId: "1234567890",
  //   appId: "1:1234567890:web:abc123",
  // },
  firebase: {
    apiKey: "AIzaSyBU4fvtTe5MYP2vYuFoVAEAtcHfx7SoHck",
    authDomain: "confra-facil.firebaseapp.com",
    projectId: "confra-facil",
    storageBucket: "confra-facil.firebasestorage.app",
    messagingSenderId: "773956627905",
    appId: "1:773956627905:web:62abc131551bce0f295340",
  },

  // "sms"     -> a pessoa recebe um código por SMS (Firebase plano Blaze; 10 SMS/dia grátis)
  // "simples" -> a pessoa informa nome e telefone, sem código (100% grátis, plano Spark)
  authMode: "simples",

  // Quem pode criar eventos (o organizador). Aceita o telefone ("(11) 98765-4321")
  // ou o SHA-256 dele no formato "+5511987654321", para não deixar o número público.
  // Quem não estiver na lista só consegue marcar datas pelo link do evento.
  // Deixe a lista vazia [] para qualquer pessoa poder criar eventos.
  adminPhones: [
    "6f7a16be077b55f156f7f4922798e42589ec29deb5f070b1f2f47291f0e1754c", // Wandesson
  ],

  // Código do país usado quando a pessoa digita só DDD + número
  defaultCountryCode: "+55",
};
