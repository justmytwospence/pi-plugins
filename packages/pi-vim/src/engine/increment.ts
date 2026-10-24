/**
 * Normal-mode CTRL-A / CTRL-X on the number at or after the cursor, after
 * Neovim's `do_addsub()` with 'nrformats' = "bin,hex": binary (`0b`),
 * hexadecimal (`0x`) and decimal numbers, a leading `-` making a decimal
 * negative, leading zeros kept, and the cursor left on the last digit.
 */

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isBin = (c: string | undefined) => c === "0" || c === "1";

export type IncrementResult = { line: string; cursorCol: number };

export function incrementNumber(line: string, cursorCol: number, delta: bigint): IncrementResult | null {
  let col = Math.max(0, Math.min(cursorCol, line.length));
  // On a hex or binary number after its prefix: back up over the digits.
  let pre: "x" | "b" | null = null;
  let scan = col;
  while (scan > 0 && isHex(line[scan])) scan--;
  if (scan > 0 && (line[scan] === "x" || line[scan] === "X") && line[scan - 1] === "0" && isHex(line[scan + 1])) {
    col = scan - 1;
    pre = "x";
  } else {
    scan = col;
    while (scan > 0 && isBin(line[scan])) scan--;
    if (scan > 0 && (line[scan] === "b" || line[scan] === "B") && line[scan - 1] === "0" && isBin(line[scan + 1])) {
      col = scan - 1;
      pre = "b";
    } else {
      col = cursorCol;
      while (col < line.length && !isDigit(line[col])) col++;
      while (col > 0 && isDigit(line[col - 1])) col--;
    }
  }
  if (!isDigit(line[col])) return null;

  let negative = false;
  if (pre === null && col > 0 && line[col - 1] === "-") {
    negative = true;
    col--;
  }
  let start = col;
  if (negative) start++;

  // Recognize the number's prefix and digits from `start`.
  let digitsStart = start;
  let base = 10;
  if (line[start] === "0" && (line[start + 1] === "x" || line[start + 1] === "X") && isHex(line[start + 2])) {
    base = 16;
    digitsStart = start + 2;
  } else if (line[start] === "0" && (line[start + 1] === "b" || line[start + 1] === "B") && isBin(line[start + 2])) {
    base = 2;
    digitsStart = start + 2;
  }
  let end = digitsStart;
  const valid = base === 16 ? isHex : base === 2 ? isBin : isDigit;
  while (end < line.length && valid(line[end])) end++;
  const digits = line.slice(digitsStart, end);
  if (base !== 10 && negative) {
    // A leading "-" is not a sign for hex and binary numbers.
    negative = false;
    col++;
  }

  const width = 64n;
  const mask = (1n << width) - 1n;
  let n = BigInt(base === 16 ? `0x${digits}` : base === 2 ? `0b${digits}` : digits) & mask;
  let subtract = delta < 0n;
  const amount = (delta < 0n ? -delta : delta) & mask;
  if (negative) subtract = !subtract;
  const old = n;
  n = subtract ? (n - amount) & mask : (n + amount) & mask;
  if (base === 10) {
    if (subtract) {
      if (n > old) {
        n = (1n + (n ^ mask)) & mask;
        negative = !negative;
      }
    } else if (n < old) {
      n = (n ^ mask) & mask;
      negative = !negative;
    }
    if (n === 0n) negative = false;
  }

  let body: string;
  if (base === 16) {
    let lastLetterUpper = false;
    for (const ch of digits) if (/[a-fA-F]/.test(ch)) lastLetterUpper = ch === ch.toUpperCase();
    body = n.toString(16);
    if (lastLetterUpper) body = body.toUpperCase();
    body = line.slice(start, digitsStart) + body.padStart(digits.length, "0");
  } else if (base === 2) {
    body = line.slice(start, digitsStart) + n.toString(2).padStart(digits.length, "0");
  } else {
    body = n.toString(10);
    if (digits.length > 1 && digits[0] === "0") body = body.padStart(digits.length, "0");
    if (negative) body = `-${body}`;
  }
  const replaceFrom = base === 10 ? col : start;
  const newLine = line.slice(0, replaceFrom) + body + line.slice(end);
  return { line: newLine, cursorCol: replaceFrom + body.length - 1 };
}
