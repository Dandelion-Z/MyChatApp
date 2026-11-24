import type { Friend } from '../api/friends'

/**
 * 通讯录分组：英文按 A-Z、中文按拼音首字母、数字与符号归入 #。
 *
 * 项目没有引入拼音词典依赖，这里使用运行环境内置的 ICU「拼音排序」能力：
 * 先用 `Intl.Collator('zh-Hans-CN-u-co-pinyin')` 比较字符，再与每个字母的
 * 拼音边界字比较，落进对应的字母分组。ICU 排序是标准库能力，不是按字符
 * 编码区间猜测的近似算法。
 *
 * 已知限制：多音字按 ICU 的默认读音归组（例如姓氏「曾」按 céng 归到 C，
 * 「单」按 dān 归到 D），与专门的姓氏词典可能不同。
 */

const PINYIN_COLLATOR = new Intl.Collator('zh-Hans-CN-u-co-pinyin')

/** 每个字母分组的拼音下界字符：字符排序 >= 该边界字即属于该字母 */
const LETTER_BOUNDARIES: ReadonlyArray<readonly [string, string]> = [
  ['八', 'B'],
  ['擦', 'C'],
  ['搭', 'D'],
  ['蛾', 'E'],
  ['发', 'F'],
  ['噶', 'G'],
  ['哈', 'H'],
  ['击', 'J'],
  ['喀', 'K'],
  ['拉', 'L'],
  ['妈', 'M'],
  ['拿', 'N'],
  ['哦', 'O'],
  ['啪', 'P'],
  ['期', 'Q'],
  ['然', 'R'],
  ['撒', 'S'],
  ['塌', 'T'],
  ['挖', 'W'],
  ['昔', 'X'],
  ['压', 'Y'],
  ['匝', 'Z']
]

const ASCII_LETTER = /^[A-Za-z]$/
const CJK_CHAR = /^[\u3400-\u4dbf\u4e00-\u9fff]$/

/** 取昵称的排序首字母；数字、符号与无法归类的名称返回 '#' */
export function getGroupLetter(name: string): string {
  const first = Array.from(name.trim())[0]

  if (!first) {
    return '#'
  }

  if (ASCII_LETTER.test(first)) {
    return first.toUpperCase()
  }

  if (!CJK_CHAR.test(first)) {
    return '#'
  }

  for (let index = LETTER_BOUNDARIES.length - 1; index >= 0; index -= 1) {
    const boundary = LETTER_BOUNDARIES[index]

    if (boundary && PINYIN_COLLATOR.compare(first, boundary[0]) >= 0) {
      return boundary[1]
    }
  }

  // 排在「八」(ba) 之前的只能是 a 开头的拼音（如 阿、爱、安）
  return 'A'
}

export type ContactGroup = {
  letter: string
  friends: Friend[]
}

function compareNames(left: string, right: string): number {
  return PINYIN_COLLATOR.compare(left, right)
}

/**
 * 按字母分组并排序。
 * - 分组顺序：A-Z 在前，# 在最后；
 * - 组内顺序：英文按字母、中文按拼音排序，同音再按原字符串兜底保证稳定。
 */
export function groupContacts(
  friends: Friend[],
  getName: (friend: Friend) => string
): ContactGroup[] {
  const buckets = new Map<string, Friend[]>()

  for (const friend of friends) {
    const letter = getGroupLetter(getName(friend))
    const bucket = buckets.get(letter)

    if (bucket) {
      bucket.push(friend)
    } else {
      buckets.set(letter, [friend])
    }
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => {
      if (left === right) {
        return 0
      }

      if (left === '#') {
        return 1
      }

      if (right === '#') {
        return -1
      }

      return left < right ? -1 : 1
    })
    .map(([letter, groupFriends]) => ({
      letter,
      friends: groupFriends.sort((left, right) => {
        const compared = compareNames(getName(left), getName(right))
        return compared !== 0 ? compared : getName(left).localeCompare(getName(right))
      })
    }))
}
