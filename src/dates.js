'use strict';

const TIME_ZONE = 'America/Sao_Paulo';
const OFFSET = 3 * 60 * 60 * 1000;
const DURATIONS = { '12 horas': { hours: 12 }, '3 dias': { days: 3 }, '1 mês': { months: 1 }, '3 meses': { months: 3 }, '12 meses': { months: 12 } };

function formatBR(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Data inválida.');
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date).replace(',', '');
}

function dateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function parseDateTimeBR(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return null;
  const [, d, m, y, h, min] = match;
  const date = new Date(`${y}-${m}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(date.getTime()) && formatBR(date) === value ? date : null;
}

function parseDateOnlyBR(value) {
  return parseDateTimeBR(`${value} 00:00`);
}

function buildRegisteredAt(data, hora, now = new Date()) {
  if (!data && !hora) return new Date(now);
  const [today, time] = formatBR(now).split(' ');
  const date = parseDateTimeBR(`${data || today} ${hora || time}`);
  if (!date) throw new Error('Data ou hora inválida. Use DD/MM/AAAA e HH:MM.');
  if (date.getTime() > now.getTime() + 60_000) throw new Error('A data da venda não pode estar no futuro.');
  return date;
}

function addMonths(value, months) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !Number.isInteger(months) || months < 0) throw new Error('Data ou duração inválida.');
  // Brasília = UTC-3. Read the local calendar in UTC, then restore its offset.
  const local = new Date(date.getTime() - OFFSET);
  const year = local.getUTCFullYear();
  const targetMonth = local.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, targetMonth, Math.min(local.getUTCDate(), lastDay), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()) + OFFSET);
}

function calculateExpiration(plan, registeredAt) {
  const duration = DURATIONS[plan];
  const date = new Date(registeredAt);
  if (!duration || !Number.isFinite(date.getTime())) throw new Error('Plano ou data inválida.');
  if (duration.months) return addMonths(date, duration.months);
  return new Date(date.getTime() + ((duration.hours || 0) + (duration.days || 0) * 24) * 3_600_000);
}

module.exports = { TIME_ZONE, formatBR, dateTimeBR: formatBR, dateKey, parseDateTimeBR, parseDateOnlyBR, buildRegisteredAt, addMonths, calculateExpiration };
