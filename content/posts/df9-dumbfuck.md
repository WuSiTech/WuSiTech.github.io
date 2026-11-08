+++
title = "笑笑传之日⑨语言"
date = "2026-11-08T21:30:00+08:00"
draft = false
description = "整活的编程语言，写起来不烧心\n不准日傻子！"
categories = [ "编程" ]
tags = [ "编译器", "汇编", "C++", "esolang" ]
cover = "/images/pool/covers/covers-19.avif"
banner = ""
lastmod = "2026-11-08T21:30:00+08:00"
+++

**dumbfuck⑨**，缩写 **DF9**，中文名 **日⑨**。仓库在 [WuSiTech/dumbfxxk](https://github.com/WuSiTech/dumbfxxk)。

先看它的 Hello World：

```text
DFI4main0,F3PRThello DF9;RET0'
```

一行，没有空格，没有分号结尾，没有 `#include`。它打印 `hello DF9`，然后正常退出。

DF9 的每个缩写理论上都能解释：`DFI4main` = **D**efine **F**unction **I**nt，名字长度 **4**，名字 `main`。但解释完你还是看不懂——这正是它想要的效果。

![从 .df 到可执行文件](/images/posts/df9/pipeline.svg)

这篇文章按“先跑起来 → 语法 → 代码生成 → 运行时 → 自举 → 一行红黑树 → 编译器实现”的顺序拆。所有示例都在 Windows + MinGW-w64 GCC 11.5 + 仓库自带 `df9.exe` 上实际编译运行过。

## 0x00 为什么会有这门语言

整活

## 0x10 先跑起来

### 0x11 构建编译器

需要 GCC / MinGW。

Linux：

```bash
g++ -std=c++17 -O2 df9.cpp -o df9
```

Windows（MinGW-w64）：

```bat
g++ -std=c++17 -O2 -static -static-libstdc++ -static-libgcc df9.cpp -o df9.exe
```

仓库里已经带了能跑的 `df9.exe`。

### 0x12 Hello World

新建 `hello.df`，内容一行：

```text
DFI4main0,F3PRThello DF9;RET0'
```

逐段拆开：

![hello.df 逐段解剖](/images/posts/df9/syntax.svg)

| 片段 | 含义 |
| --- | --- |
| `DFI4main` | Define Function，返回 `I`nt，名字长 4，名字 `main` |
| `0` | 参数个数 0 |
| `,` | 多语句函数体开始 |
| `F3PRT` | `F` + 长度 `3` + 关键字 `PRT`，打印 |
| `hello DF9` | 裸文本，原样输出，直到 `;` |
| `;` | 语句结束 |
| `RET0` | 返回 0 |
| `'` | 函数体结束 |

编译、链接、运行：

```bash
./df9 hello.df > hello.s
gcc -no-pie hello.s -o hello -lpthread -lm
./hello
```

Windows 下：

```bat
df9.exe hello.df > hello.s
gcc hello.s -o hello.exe -lpthread -lm
hello.exe
```

也可以直接跑 `compile.bat`，输入文件名，它帮你做完三步并运行。

> **PowerShell 的坑**：PowerShell 5.1 的 `>` 会写出 UTF-16，GCC 看到 `invalid character (0xff)` 直接拒绝。用 `cmd /c`、`compile.bat`，或者显式转成 UTF-8 无 BOM。

### 0x13 编译器出来的汇编

`hello.df` 生成的 `hello.s`（Windows 版，Linux 少几行 `sub $32,%rsp` 的影子空间）：

```asm
.text
.globl main
main:
 push %rbp
 mov %rsp,%rbp
 lea .LC0(%rip),%rcx
 sub $32, %rsp
 call puts
 add $32, %rsp
 mov $0,%eax
 jmp .Lret_main
.Lret_main:
 leave
 ret
```

字符串统一进 `.rodata`：

```asm
.section .rodata
.Lfmt:
 .string "%d\n"
.LC0:
 .string "hello DF9"
```

也就是说，DF9 不负责“运行”，它只负责把源码翻译成汇编；剩下的交给 `as`、`ld` 和系统 ABI。

## 0x20 九条戒律

见项目readme

## 0x30 表达式与代码生成

DF9 的表达式优先级是手写的递归下降链：

```text
genExpr → genRel → genAdd → genMul → genPrimary
```

对应 C 的：

```text
关系运算 → 加减 → 乘除模 → 括号/数字/变量/数组/函数调用
```

`genRel` 直接把比较结果归一化成 0/1：

```cpp
emit("cmp %eax,%ecx");
emit("setl %al");        // a < b
emit("movzbl %al,%eax");
```

`genAdd` / `genMul` 用 `push %rax` / `pop %rcx` 保存左值，再对 `%eax` 做运算；除法用 `cltd` + `idiv`，取模再从 `%edx` 搬回 `%eax`。

赋值和数组下标是分开处理的：

```text
x&1         →  mov %eax,x(%rip)
a#i&1       →  先算 i，再 lea 基址，最后 mov %eax,(%r11)
a#i         →  先算 i，再 movl (%rbx,%rcx,4),%eax
```

全局变量放 `.bss` / `.data`，局部变量在 `rbp-offset`；函数结束时把 `maxStack` 按 16 字节对齐，生成 `sub $N,%rsp`。

函数调用按 ABI 分两套：

| 平台 | 参数寄存器 | 上限 |
| --- | --- | --- |
| Linux SysV | `%edi %esi %edx %ecx %r8d %r9d` | 6 |
| Windows Win64 | `%ecx %edx %r8d %r9d` | 4 |

参数从右往左 `pop` 进寄存器；Windows 还要在调用前留 32 字节影子空间。超过上限直接编译报错。

## 0x40 控制流

`if` 的条件后面必须 `,`，`then` 块用 `'` 结束，`else` 必须紧跟 `then` 的闭引号：

```text
F2IF(x]5),F3PRT"small"'F2EL,F3PRT"big"'
```

`while`：

```text
F1W(x]5),x&x+1'
```

`for` 用 `~` 分隔三段，而不是分号：

```text
F2FRi&0~i]5~i&i+1,F3PRT(i)'
```

输出 `0 1 2 3 4`。

`break` / `continue` 用循环栈记标签；但 `continue` 直接跳到循环开头，**跳过了步进**，所以会死循环或输出怪序列。这是 README 明确承认的 bug，不是你的错。

标签与跳转：

```text
@2lp            // 定义标签 lp（长度 2）
F3JMPlp         // goto lp
```

标签会被编译成 `.Llp`；`.L` 标签全文件共享，两个函数用同名标签会撞车。

## 0x50 字节 I/O 与运行时

DF9 后来加了一组直接读写字节的内建词，自举种子就靠它们活着：

| 写法 | 作用 | 备注 |
| --- | --- | --- |
| `F3GET()` | 读一个字节，EOF 返回 -1 | 括号可省，可进表达式 |
| `F4PEEK()` | 偷看下一个字节 | **实验性，当前会卡住/崩溃** |
| `F3PUT(expr)` | 输出一个字节，不换行 | 必须括号 |
| `F4EMIT("text")` | `puts` + 换行 | 必须括号 |
| `F4EXIT` | 退出，状态 0 | 无参数 |

回显程序：

```text
DFI4main0,DI1c0;F1W(1),c&F3GET();F2IF(c=-1),F1B'F3PUT(c)'F4EXIT'
```

喂 `abc`，输出 `abc`。

它们不是普通函数，是 `parseF` 直接处理的内建词；生成代码会调用 `__df_get` / `__df_put` / `__df_emit` / `__df_peek`。这几个运行时就是 `getchar` / `putchar` / `puts` / `ungetc` 的薄包装。

`F4PEEK` 目前是半成品：生成的 `ungetc` 没拿到有效的 `FILE*`，README 自己写着“先别用”。

### 0x51 BOM

`skip()` 会跳过文件开头的 UTF-8 BOM，所以记事本保存的源码不会再把 `main` 吃掉。

但只跳过一个：如果文件里有两个 BOM（比如某些工具又加了一层），第二个会被当成源码，照样报错。我实测单 BOM 正常、双 BOM 失败。

## 0x60 线程

`^` 表示并发，连续的 `^` 会一起启动、一起 join：

```text
DFV3foo0,F3PRT"thread";'
DFI4main0,^F3foo()^F3foo();F3PRT"main";RET0'
```

输出（顺序可能变）：

```text
thread
thread
main
```

每个 `^` 语句会被复制成一个独立函数 `__df_thr_N`，然后生成 `pthread_create` / `pthread_join`。

坑：线程体被复制成独立函数，但**没有为局部变量分配栈空间**，`%rbp` 不会替你圆场。线程里别碰局部变量，只能用全局数组/变量。

## 0x70 自举种子：df9_df.df

`df9_df.df` 是一个用 DF9 写的代码生成器雏形：把源码读进 `SRC*65536`，用 `F3GET` 读 stdin，用 `F4EMIT` / `F3PUT` 往 stdout 吐汇编。

构建：

```text
df9.exe df9_df.df > df9_df.s
gcc df9_df.s -o df9_df.exe -lpthread -lm
df9_df.exe < seed_input.df > out.s
```

最小输入 `seed_input.df`：

```text
RET0'
```

生成的 `out.s`：

```asm
.text
.globl main
main:
 push %rbp
 mov %rsp,%rbp
 xor %eax,%eax
 leave
 ret
```

`RET` 路径是通的；带 `PRT` 的路径还在施工。它还不是完整编译器，但已经是自举的第一步。

## 0x80 终极测试：一行红黑树

README 里有一行 1313 个字符的红黑树：五个全局数组 `KEY/LC/RC/PA/CO`，实现插入、`fixup`、左右旋和中序遍历。

我把它原样抽出来编译运行，输出确实是有序的：

```text
2
3
6
7
8
10
11
18
22
26
```

源码太长，折叠在这里：

{{< details summary="点开受诅咒的一行（真的能跑）" >}}

```text
DI3KEY*21;DI2LC*21;DI2RC*21;DI2PA*21;DI2CO*21;DI4ROOT0;DI4NEXT0;DFV6insert1I1k,DI1z0;DI1y0;DI1x0;z&NEXT;NEXT&NEXT+1;KEY#z&k;LC#z&0;RC#z&0;PA#z&0;CO#z&0;y&0;x&ROOT;F1W(x!0),y&x;F2IF(k](KEY#x)),x&LC#x'F2EL,x&RC#x''PA#z&y;F2IF(y=0),ROOT&z'F2EL,F2IF(k](KEY#y)),LC#y&z'F2EL,RC#y&z''CO#z&0;F5fixup(z)'DFV5fixup1I1z,DI1y0;F1W((PA#z)!0),F2IF(((CO#PA#z)!0)),F1B'F2IF((PA#z)=(LC#(PA#PA#z))),y&RC#(PA#PA#z);F2IF((CO#y)=0),CO#PA#z&1;CO#y&1;CO#(PA#PA#z)&0;z&PA#PA#z'F2EL,F2IF(z=(RC#(PA#z))),z&PA#z;F10leftrotate(z)'CO#PA#z&1;CO#(PA#PA#z)&0;F11rightrotate(PA#PA#z)''F2EL,y&LC#(PA#PA#z);F2IF((CO#y)=0),CO#PA#z&1;CO#y&1;CO#(PA#PA#z)&0;z&PA#PA#z'F2EL,F2IF(z=(LC#(PA#z))),z&PA#z;F11rightrotate(z)'CO#PA#z&1;CO#(PA#PA#z)&0;F10leftrotate(PA#PA#z)'''CO#ROOT&1'DFV10leftrotate1I1x,DI1y0;y&RC#x;RC#x&LC#y;F2IF((LC#y)!0),PA#LC#y&x'PA#y&PA#x;F2IF((PA#x)=0),ROOT&y'F2EL,F2IF((LC#(PA#x))=x),LC#(PA#x)&y'F2EL,RC#(PA#x)&y''LC#y&x;PA#x&y'DFV11rightrotate1I1x,DI1y0;y&LC#x;LC#x&RC#y;F2IF((RC#y)!0),PA#RC#y&x'PA#y&PA#x;F2IF((PA#x)=0),ROOT&y'F2EL,F2IF((RC#(PA#x))=x),RC#(PA#x)&y'F2EL,LC#(PA#x)&y''RC#y&x;PA#x&y'DFV7inorder1I1x,F2IF(x!0),F7inorder(LC#x);F3PRT(KEY#x);F7inorder(RC#x)''DFI4main0,NEXT&1;F6insert(10);F6insert(6);F6insert(18);F6insert(3);F6insert(8);F6insert(11);F6insert(22);F6insert(2);F6insert(7);F6insert(26);F7inorder(ROOT);RET0'
```

{{< /details >}}

## 0x90 编译器本身

`df9.cpp` 1101 行，结构非常直接：

- `Compiler` 类持有源码、`pos`、全局/局部符号表、函数体、字符串池；
- `skip()` 处理空白、`//`、`/* */`、BOM；
- `parseF()` 是最大的函数，处理所有 `F` 词和函数调用；
- `parseFunction()` / `parseGlobal()` 处理顶层；
- `genExpr` 一族边解析边 `emit()` 汇编；
- 最后 `compile()` 按 `.text → 全局 → 函数 → 运行时 → .rodata` 拼输出。

它没有 AST，所以错误定位只有 `pos`：

```text
DF9 error: expect ')' got '$' at pos 20
near: ...
```

也没有优化：你的代码怎么写，它就怎么翻译，连常量折叠都没有。

## 0xA0 值得学吗？

自己写的，学起来不烧心

## 0xC0 最后

> 作者不对以下情况负责：脑损伤、眼出血、误提交、同事报警、代码评审被打、以及你试图用 DF9 写 Web 后端。

仓库地址：[https://github.com/WuSiTech/dumbfxxk](https://github.com/WuSiTech/dumbfxxk)

License: MIT (Make It Torturous)。
