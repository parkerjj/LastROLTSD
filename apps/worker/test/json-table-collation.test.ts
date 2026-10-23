import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// JSON_TABLE 的文本列继承连接排序规则。直连时握手指定了 utf8mb4_0900_ai_ci，与表一致；
// Hyperdrive 不转发握手排序规则，文本列会变成别的排序规则，和表列比较就报 1267。
// 所以每个文本列都必须显式写 COLLATE，不依赖连接排序规则。
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('JSON_TABLE 文本列排序规则', () => {
  it('每个 CHAR/VARCHAR 列都显式声明 COLLATE utf8mb4_0900_ai_ci', () => {
    const offenders = sourceFiles(join(__dirname, '../src')).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\b(?:VARCHAR|CHAR)\(\d+\)(?:\s+COLLATE\s+\w+)?\s+PATH/g)]
        .filter((match) => !match[0].includes('COLLATE utf8mb4_0900_ai_ci'))
        .map((match) => `${file}: ${match[0]}`));
    expect(offenders).toEqual([]);
  });
});
