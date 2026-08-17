"use strict";

// Express 4 não repassa automaticamente erros de handlers assíncronos pro
// middleware de erro — esse wrapper captura qualquer throw/rejeição da
// Promise e chama next(err), caindo no tratamento de erro central do
// index.js. Use em toda rota que faz "await" em alguma consulta ao banco.
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
