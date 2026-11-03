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
  firebase: null,

  // "sms"     -> a pessoa recebe um código por SMS (Firebase plano Blaze; 10 SMS/dia grátis)
  // "simples" -> a pessoa informa nome e telefone, sem código (100% grátis, plano Spark)
  authMode: "simples",

  // Código do país usado quando a pessoa digita só DDD + número
  defaultCountryCode: "+55",
};
