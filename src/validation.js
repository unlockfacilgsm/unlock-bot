'use strict';

const { getPlan } = require('./catalog');

function text(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} inválido: informe de 1 a ${max} caracteres, sem quebra de linha.`);
  }
  return value.trim();
}

function password(value) {
  if (typeof value !== 'string' || !value.length || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Senha inválida: informe de 1 a 200 caracteres, sem quebra de linha.');
  }
  return value;
}

function id(value, prefix) {
  const result = text(value, 'ID', 64).toUpperCase();
  if (!new RegExp(`^${prefix}-(?:LEGACY-)?\\d+$`).test(result)) throw new Error(`ID inválido. Use ${prefix}-001, por exemplo.`);
  return result;
}

function cents(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
    throw new Error(`${label} inválido. Use um valor positivo com até duas casas decimais.`);
  }
  return Math.round(value * 100);
}

function amounts(tool, plan, value, discount) {
  const definition = getPlan(tool, plan);
  const gross = value == null ? definition.priceCents : cents(value, 'Valor');
  const discountCents = discount == null ? 0 : cents(discount, 'Desconto');
  if (discountCents > gross) throw new Error('O desconto não pode superar o valor da venda.');
  return { priceCents: gross - discountCents, discountCents };
}

function confirmed(value) {
  if (value !== true) throw new Error('Confirme a troca da senha na ferramenta externa antes de registrar a alteração.');
}

module.exports = { text, password, id, cents, amounts, confirmed };
