+++
title = "STM32 内部 FLASH：页擦除、半字编程、选项字节与芯片 ID"
date = "2026-11-06T21:00:00+08:00"
lastmod = "2026-11-06T23:59:00+08:00"
draft = false
description = "把程序存储器当“掉电不丢的小硬盘”：讲清 F103 的 Flash 分块与页大小、FPEC 解锁序列、页擦除/半字编程、EOP/BSY 等待、选项字节与读保护、96 位 UID，给出参数存储、双页轮换、校验的完整 .h/.c/main.c 与 12 条故障排查。"
categories = [ "STM32" ]
tags = [ "STM32", "FLASH", "IAP" ]
cover = "/images/pool/covers/covers-18.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 15 章（15-1、15-2）。

代码基于 **STM32F103C8T6 + 标准外设库 3.5.0**，不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 15-1 | Flash 简介、闪存模块组织、页擦除、编程、选项字节、读保护 | 0x10 ~ 0x50、0x70 |
| 15-2 | 读写内部 Flash、读取芯片 ID | 0x60、0x80 ~ 0x90 |

视频之外还补了：FPEC 寄存器、EOP/BSY 细节、参数存储与双页轮换、寿命与磨损、掉电保护、UID 应用、12 条故障排查。

## 0x00 为什么要读写内部 Flash

单片机掉电后 RAM 全丢，但有些数据必须留下来：

- 校准参数、设备配置、累计运行时间；
- 开机次数、故障记录；
- IAP/OTA 升级时的新固件；
- 想省一颗 EEPROM 的成本。

STM32 的内部 Flash 除了放程序，也可以划出一段当“参数区”。代价是：

- **擦除粒度大**（1 KB/页）；
- **写入前必须先擦**；
- **擦写寿命有限**（约 1 万次）。

### 0x01 与 EEPROM/SPI Flash 的取舍

| 项目 | 内部 Flash | EEPROM | SPI Flash |
| ---- | ---------- | ------ | --------- |
| 容量 | 64 KB | 256 B ~ 64 KB | 几 MB |
| 擦除粒度 | 1 KB | 页/整片 | 4 KB |
| 写入粒度 | 16 位 | 1 字节 | 256 B |
| 寿命 | 1 万次 | 100 万次 | 10 万次 |
| 速度 | 慢 | 慢 | 快 |
| 成本 | 0 | 低 | 低 |

少量参数用内部 Flash 最省；频繁改写用 EEPROM/FRAM；大文件用 SPI Flash。

### 0x02 内部 Flash 的可靠性

- 擦写次数有限（1 万次），但正常参数保存（每天几次）能用十几年；
- 高温会加速老化；
- 掉电时写 Flash 可能写坏当前页（所以参数区要留备份页）；
- 读保护/写保护能防误操作，但也可能把自己锁死。

### 0x03 典型应用场景

- 保存设备配置（IP、波特率、量程）；
- 保存校准系数；
- 记录运行时长/开机次数；
- 存升级标志/固件备份；
- 存日志（少量）。

不适合：高频写（> 每天几十次）、大文件（用外部 Flash）。

## 0x10 Flash 结构

![Flash 基本结构](/images/posts/stm32-flash/flash-structure.webp)

F103C8T6 的 64 KB Flash 分成三块：

| 区域 | 起始地址 | 大小 | 用途 |
| ---- | -------- | ---- | ---- |
| 主存储区 | 0x0800 0000 | 64 KB | 用户程序 + 参数 |
| 系统存储器 | 0x1FFF F000 | 2 KB | 出厂 BootLoader（串口 ISP） |
| 选项字节 | 0x1FFF F800 | 16 B | 读保护/写保护/用户数据 |

主存储区按 **1 KB 一页** 划分（中容量），C8T6 共 64 页（页 0 ~ 页 63）。擦除最小单位是**页**，编程最小单位是**半字（16 位）**。

![闪存模块组织](/images/posts/stm32-flash/flash-org.webp)

### 0x11 地址换算

```text
页号 = (Address - 0x08000000) / 1024
页内偏移 = (Address - 0x08000000) % 1024
```

例如 `0x0800FC00`：

```text
(0xFC00) / 0x400 = 63 → 第 63 页（最后一页）
```

### 0x12 FPEC 寄存器

| 寄存器 | 作用 | 关键位 |
| ------ | ---- | ------ |
| `FLASH_ACR` | 访问控制 | LATENCY、PRFTBE |
| `FLASH_KEYR` | 解锁钥匙 | KEY1/KEY2 |
| `FLASH_OPTKEYR` | 选项字节钥匙 | 同上 |
| `FLASH_SR` | 状态 | BSY、PGERR、WRPRTERR、EOP |
| `FLASH_CR` | 控制 | PG、PER、MER、OPTPG、OPTER、STRT、LOCK、OPTWRE |
| `FLASH_AR` | 地址 | 擦除页地址 |
| `FLASH_OBR` | 选项字节读 | RDPRT、USER、Data |
| `FLASH_WRPR` | 写保护 | 每页一位 |

### 0x13 容量与页表

C8T6 的 64 KB：

```text
页 0  : 0x08000000 ~ 0x080003FF
页 1  : 0x08000400 ~ 0x080007FF
...
页 63 : 0x0800FC00 ~ 0x0800FFFF
```

参数区通常放最后一页（0x0800FC00），万一写坏也不影响前面代码。程序实际大小看 `.map` 文件；IROM 配置要留出参数区。

### 0x14 启动映射

上电时，Flash 被映射到 0x00000000（取决于 BOOT0/BOOT1），所以中断向量表在 0x08000000 也能被内核找到。IAP 跳转时要改 `SCB->VTOR`。

### 0x15 读保护与调试

开了读保护后：

- SWD 连接会失败/只能擦除；
- 串口 ISP 也读不出 Flash；
- 解除保护 = 全片擦除。

调试阶段千万别开；量产时再开。

### 0x16 IAP 与向量表

IAP（在应用编程）把 Flash 分成 BootLoader + APP：

```text
0x08000000  BootLoader
0x08004000  APP（向量表偏移 0x4000）
```

APP 里要设：

```c
SCB->VTOR = 0x08004000;
```

否则中断会跳到 BootLoader 的向量表。跳转前还要关中断、设 MSP。

### 0x17 读保护与量产

读保护是“防抄板”的第一道门，但不是绝对的：

- 可以通过侧信道/开盖读；
- 高安全用外部加密芯片/STM32 的 PCROP（部分型号）；
- 读保护打开后，调试/量产流程都要改。

## 0x20 读 Flash

读最简单，Flash 被映射到地址空间，直接指针访问：

```c
uint16_t MyFLASH_ReadHalfWord(uint32_t Address)
{
    return *(__IO uint16_t *)Address;
}

uint32_t MyFLASH_ReadWord(uint32_t Address)
{
    return *(__IO uint32_t *)Address;
}

void MyFLASH_ReadBuffer(uint32_t Address, uint8_t *Buffer, uint32_t Length)
{
    for (uint32_t i = 0; i < Length; i++)
    {
        Buffer[i] = *(__IO uint8_t *)(Address + i);
    }
}
```

`__IO` 就是 `volatile`，防止编译器把读操作优化掉。读没有对齐要求（字节/半字/字都可以），但按字读最快。

### 0x23 读优化

- 按字（32 位）读比按字节快；
- 大块读取可以用 DMA（Flash 到 RAM 的 M2M）；
- 读 Flash 不占用 FPEC，可以和擦写并行（不同页）；
- 但擦除/编程期间读同一块 Flash 会 stall。

### 0x24 数据校验

Flash 存储也会位翻转（尤其是接近寿命时）。参数区加 CRC：

```c
uint16_t crc = Param_CRC16((uint8_t *)Param, sizeof(ParamBlock) - 2);
if (crc != Param->Crc) { /* 用默认值 */ }
```

关键固件可以做双备份 + 启动校验。

### 0x26 等待周期与读速度

主频越高，Flash 读等待周期越多：

| 主频 | LATENCY |
| ---- | ------- |
| ≤24 MHz | 0 |
| 24 ~ 48 MHz | 1 |
| 48 ~ 72 MHz | 2 |

`FLASH_SetLatency()` 在时钟初始化里设置；改主频后忘了改等待周期，会读错指令/数据。Prefetch Buffer 能提高顺序取指效率。

## 0x30 解锁与钥匙

FPEC（Flash 编程/擦除控制器）复位后是**锁定**的，不能写 `FLASH_CR`。解锁要按顺序写两个键：

```text
KEY1 = 0x45670123
KEY2 = 0xCDEF89AB
```

顺序写错、或者中间插了别的操作，会锁死到下次复位。标准库：

```c
FLASH_Unlock();   /* 内部写 KEYR */
FLASH_Lock();     /* 置 LOCK 位 */
```

选项字节有独立的钥匙（`OPTKEYR`）和 `OPTWRE` 位，解锁方式相同。

### 0x31 错误标志

- **PGERR**：编程到非 0xFF 的位置（没擦除）；
- **WRPRTERR**：写了被写保护的页；
- **EOP**：操作完成（编程/擦除结束）；
- **BSY**：忙。

错误标志要写 1 清除（`FLASH_ClearFlag`），否则下次操作会受影响。

### 0x32 解锁失败与错误处理

标准库的 `FLASH_Unlock()` 返回 `FLASH_Status`，但很多人忽略：

```c
FLASH_Status status;

FLASH_Unlock();
status = FLASH_ErasePage(PageAddress);
FLASH_Lock();

if (status != FLASH_COMPLETE)
{
    /* 擦除失败：PGERR/WRPRTERR/EOP 超时 */
    Error_Handler(status);
}
```

如果钥匙写错，`FLASH_CR` 会被锁死到下次复位；只能靠 `NVIC_SystemReset()` 恢复。

### 0x33 写保护与错误

- 写保护页擦除/编程 → `WRPRTERR`；
- 写非 0xFF 位置 → `PGERR`；
- 超时 → `FLASH_TIMEOUT`。

错误发生后：

```c
FLASH_ClearFlag(FLASH_FLAG_PGERR | FLASH_FLAG_WRPRTERR | FLASH_FLAG_EOP);
```

不清标志，下一次操作可能直接返回错误。

### 0x37 钥匙错误的案例

- 现象：擦除函数返回失败，之后所有 Flash 操作都失败；
- 原因：解锁时只写了 KEY1，没写 KEY2；
- 结论：`FLASH_Unlock()` 必须完整调用；错误后只能复位。

另一个：

- 现象：写保护页写不进去；
- 原因：选项字节 WRP 配错；
- 结论：用 ST-LINK Utility 查看/清除 WRP。

## 0x40 擦除

![页擦除流程](/images/posts/stm32-flash/flash-erase.webp)

**页擦除**：

1. 解锁；
2. 置 `PER=1`；
3. 把页地址写进 `AR`；
4. 置 `STRT=1`；
5. 等待 `BSY=0`；
6. 读出验证（应为 0xFFFF）；
7. 清 EOP，锁定。

标准库：

```c
FLASH_Unlock();
FLASH_ErasePage(PageAddress);   /* 内部等 BSY、返回状态 */
FLASH_Lock();
```

**全擦除**用 `FLASH_EraseAllPages()`（`MER=1`），耗时按容量算，C8T6 约 1 ~ 2 s。

**选项字节擦除**用 `FLASH_EraseOptionBytes()`（`OPTER=1`）。

### 0x42 擦除/编程时序

| 操作 | 典型时间 | 最大时间 |
| ---- | -------- | -------- |
| 页擦除（1 KB） | 20 ms | 40 ms |
| 全片擦除（64 KB） | 1 s | 2 s |
| 半字编程 | 40 µs | 70 µs |
| 选项字节擦除 | 20 ms | 40 ms |

所以“保存一次参数”≈ 40 ms，不能放在高频中断里。

### 0x43 擦写期间的中断与取指

擦除/编程时 FPEC 会占用 Flash 接口：

- CPU 从 Flash 取指会被 stall；
- 中断向量表在 Flash，中断会延迟；
- 代码如果也在同一块 Flash，等于“边擦边跑”，只能靠硬件 stall 保证不崩。

稳妥做法：

- 擦写前后关中断（`__disable_irq()`）；
- 或把擦写函数放到 RAM 里执行（链接到 RAM）；
- 擦写时间长的操作分段做。

```c
__disable_irq();
MyFLASH_ErasePage(ADDR);
__enable_irq();
```

### 0x44 擦写次数与磨损

- 每页约 1 万次；
- 每次改参数都擦一页，频繁写会很快耗尽；
- 双页轮换、日志式追加、磨损均衡能延长寿命；
- 超过寿命后可能出现“写不进去/读出错”。

### 0x45 全擦除与选项字节擦除

```c
FLASH_Unlock();
FLASH_EraseAllPages();       /* MER=1，整片 */
FLASH_Lock();
```

全擦除会连程序一起擦掉，只能在 BootLoader/ISP 里用。选项字节擦除用 `FLASH_EraseOptionBytes()`，会把 RDP/WRP/USER 恢复默认。

全擦除耗时与容量成正比，C8T6 约 1 ~ 2 s，期间不能断电。

### 0x46 批量擦除策略

- 只擦要写的页，别动不动全擦；
- 参数区按页管理，写哪页擦哪页；
- 固件升级才全擦/按块擦。

## 0x50 编程

**半字编程**：

1. 解锁；
2. 置 `PG=1`；
3. 向目标地址写一个 16 位半字；
4. 等待 `BSY=0`；
5. 读出验证；
6. 清 EOP，锁定。

```c
FLASH_Unlock();
FLASH_ProgramHalfWord(Address, Data);
FLASH_Lock();
```

三条硬规则：

- **写之前必须擦**：Flash 只能把 1 写成 0，不能把 0 写回 1；
- **地址必须半字对齐**：写 16 位时地址是偶数；
- **擦除/编程期间不能访问 Flash**：CPU 取指会被总线 stall，中断会延迟。

### 0x51 32 位写入

F103 只支持半字编程，32 位要拆成两个半字：

```c
void MyFLASH_ProgramWord(uint32_t Address, uint32_t Data)
{
    FLASH_ProgramHalfWord(Address, Data & 0xFFFF);
    FLASH_ProgramHalfWord(Address + 2, Data >> 16);
}
```

### 0x52 编程对齐与宽度

- 只支持半字（16 位），地址必须是偶数；
- 写字节/奇数长度要自己拼成半字，最后一个字节补 0xFF；
- 写 32 位要拆两个半字；
- 写之前该地址必须是 0xFFFF，否则 PGERR。

```c
uint16_t Pack(const uint8_t *Buf, uint32_t Index, uint32_t Length)
{
    uint16_t Data = 0xFFFF;

    Data &= ~0xFF;
    Data |= Buf[Index];
    if (Index + 1 < Length) Data = (Data & 0xFF00) | Buf[Index + 1];

    return Data;
}
```

## 0x60 代码实现

本篇代码文件：

| 文件 | 作用 |
| ---- | ---- |
| `MyFLASH.h` / `MyFLASH.c` | 读、擦、写、校验 |
| `Param.h` / `Param.c` | 参数存储（magic + 版本 + CRC） |
| `main.c` | 读写参数、读 ID |

### 0x61 MyFLASH.h

```c
#ifndef __MYFLASH_H
#define __MYFLASH_H

#include "stm32f10x.h"

uint16_t MyFLASH_ReadHalfWord(uint32_t Address);
uint32_t MyFLASH_ReadWord(uint32_t Address);
void MyFLASH_ReadBuffer(uint32_t Address, uint8_t *Buffer, uint32_t Length);

void MyFLASH_ErasePage(uint32_t PageAddress);
void MyFLASH_EraseAll(void);

void MyFLASH_ProgramHalfWord(uint32_t Address, uint16_t Data);
void MyFLASH_ProgramWord(uint32_t Address, uint32_t Data);
void MyFLASH_WriteBuffer(uint32_t Address, uint8_t *Buffer, uint32_t Length);

uint8_t MyFLASH_Verify(uint32_t Address, uint8_t *Buffer, uint32_t Length);

#endif
```

### 0x62 MyFLASH.c

```c
#include "MyFLASH.h"

uint16_t MyFLASH_ReadHalfWord(uint32_t Address)
{
    return *(__IO uint16_t *)Address;
}

uint32_t MyFLASH_ReadWord(uint32_t Address)
{
    return *(__IO uint32_t *)Address;
}

void MyFLASH_ReadBuffer(uint32_t Address, uint8_t *Buffer, uint32_t Length)
{
    for (uint32_t i = 0; i < Length; i++)
    {
        Buffer[i] = *(__IO uint8_t *)(Address + i);
    }
}

void MyFLASH_ErasePage(uint32_t PageAddress)
{
    FLASH_Unlock();
    FLASH_ErasePage(PageAddress);
    FLASH_Lock();
}

void MyFLASH_EraseAll(void)
{
    FLASH_Unlock();
    FLASH_EraseAllPages();
    FLASH_Lock();
}

void MyFLASH_ProgramHalfWord(uint32_t Address, uint16_t Data)
{
    FLASH_Unlock();
    FLASH_ProgramHalfWord(Address, Data);
    FLASH_Lock();
}

void MyFLASH_ProgramWord(uint32_t Address, uint32_t Data)
{
    FLASH_Unlock();
    FLASH_ProgramHalfWord(Address, (uint16_t)(Data & 0xFFFF));
    FLASH_ProgramHalfWord(Address + 2, (uint16_t)(Data >> 16));
    FLASH_Lock();
}

void MyFLASH_WriteBuffer(uint32_t Address, uint8_t *Buffer, uint32_t Length)
{
    FLASH_Unlock();

    for (uint32_t i = 0; i < Length; i += 2)
    {
        uint16_t Data = Buffer[i];
        if (i + 1 < Length) Data |= (uint16_t)Buffer[i + 1] << 8;

        FLASH_ProgramHalfWord(Address + i, Data);
    }

    FLASH_Lock();
}

uint8_t MyFLASH_Verify(uint32_t Address, uint8_t *Buffer, uint32_t Length)
{
    for (uint32_t i = 0; i < Length; i++)
    {
        if (*(__IO uint8_t *)(Address + i) != Buffer[i]) return 0;
    }
    return 1;
}
```

### 0x63 参数存储

```c
#define PARAM_ADDR 0x0800FC00   /* 最后一页 */

typedef struct
{
    uint32_t Magic;      /* 0x55AA1234 */
    uint16_t Version;
    uint16_t Length;
    uint8_t  Data[32];
    uint16_t Crc;
} ParamBlock;

uint16_t Param_CRC16(uint8_t *Buf, uint16_t Len)
{
    uint16_t Crc = 0xFFFF;

    for (uint16_t i = 0; i < Len; i++)
    {
        Crc ^= Buf[i];
        for (uint8_t j = 0; j < 8; j++)
        {
            Crc = (Crc & 1) ? (Crc >> 1) ^ 0xA001 : (Crc >> 1);
        }
    }

    return Crc;
}

uint8_t Param_Save(ParamBlock *Param)
{
    Param->Magic = 0x55AA1234;
    Param->Version = 1;
    Param->Crc = Param_CRC16((uint8_t *)Param, sizeof(ParamBlock) - 2);

    MyFLASH_ErasePage(PARAM_ADDR);
    MyFLASH_WriteBuffer(PARAM_ADDR, (uint8_t *)Param, sizeof(ParamBlock));

    return MyFLASH_Verify(PARAM_ADDR, (uint8_t *)Param, sizeof(ParamBlock));
}

uint8_t Param_Load(ParamBlock *Param)
{
    MyFLASH_ReadBuffer(PARAM_ADDR, (uint8_t *)Param, sizeof(ParamBlock));

    if (Param->Magic != 0x55AA1234) return 0;

    return Param->Crc == Param_CRC16((uint8_t *)Param, sizeof(ParamBlock) - 2);
}
```

### 0x64 main.c

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "Serial.h"
#include "MyFLASH.h"

ParamBlock Param;

int main(void)
{
    Serial_Init();

    if (Param_Load(&Param))
    {
        printf("Load OK, version=%d\r\n", Param.Version);
    }
    else
    {
        printf("Load FAIL, use default\r\n");
        Param.Version = 1;
        Param.Length = sizeof(Param.Data);
    }

    Param.Data[0]++;
    printf("Save: %d\r\n", Param_Save(&Param));

    while (1)
    {
    }
}
```

### 0x65 双页轮换存储

一页写满/写坏就换另一页，寿命翻倍，还能防掉电：

```c
#define PAGE_A 0x0800F800
#define PAGE_B 0x0800FC00

typedef struct
{
    uint32_t Magic;
    uint32_t Sequence;     /* 递增序号 */
    uint8_t  Data[32];
    uint16_t Crc;
} RotateBlock;

uint32_t Param_Save_Rotate(RotateBlock *Block)
{
    RotateBlock A, B;
    uint32_t Target;

    MyFLASH_ReadBuffer(PAGE_A, (uint8_t *)&A, sizeof(A));
    MyFLASH_ReadBuffer(PAGE_B, (uint8_t *)&B, sizeof(B));

    /* 选序号较旧/无效的页作为写入目标 */
    if (A.Magic == 0x55AA1234 && B.Magic == 0x55AA1234)
    {
        Target = (A.Sequence <= B.Sequence) ? PAGE_A : PAGE_B;
        Block->Sequence = ((A.Sequence > B.Sequence) ? A.Sequence : B.Sequence) + 1;
    }
    else
    {
        Target = (A.Magic == 0x55AA1234) ? PAGE_B : PAGE_A;
        Block->Sequence = 1;
    }

    Block->Magic = 0x55AA1234;
    Block->Crc = Param_CRC16((uint8_t *)Block, sizeof(RotateBlock) - 2);

    MyFLASH_ErasePage(Target);
    MyFLASH_WriteBuffer(Target, (uint8_t *)Block, sizeof(RotateBlock));

    return MyFLASH_Verify(Target, (uint8_t *)Block, sizeof(RotateBlock));
}
```

读取时选“Magic 正确、CRC 正确、Sequence 最大”的那一份。

### 0x66 参数版本升级

产品升级后结构体可能加字段，用版本号兼容：

```c
if (Param.Version == 1)
{
    /* 旧结构：补默认值 */
    Param.NewField = 0;
    Param.Version = 2;
    Param_Save(&Param);
}
```

新字段放结构体尾部，旧数据前面不变，读出来再补默认值。

### 0x67 默认值与恢复出厂

参数区无效时用一套默认值：

```c
const ParamBlock DefaultParam = {
    .Magic = 0x55AA1234,
    .Version = 1,
    .Length = 32,
    .Data = {0},
};

if (!Param_Load(&Param))
{
    Param = DefaultParam;
    Param_Save(&Param);
}
```

“恢复出厂”就是擦参数页 + 写默认值；可以留一个按键组合或串口命令。

### 0x68 参数加密

Flash 内容可被读出（未开读保护时），敏感参数可以简单加密：

```c
void Param_Xor(uint8_t *Data, uint16_t Len, uint8_t Key)
{
    for (uint16_t i = 0; i < Len; i++) Data[i] ^= Key;
}
```

保存前异或，读取后异或；密钥可以来自 UID。真正的安全要靠加密芯片/安全启动，异或只是“防君子”。

### 0x69 参数区布局示例

```text
0x0800F800  参数页 A（1KB）
             ├─ Magic      4B
             ├─ Version    2B
             ├─ Sequence   4B
             ├─ Data      32B
             └─ CRC        2B
0x0800FC00  参数页 B（1KB）
             同上
```

两页交替写，任何一页损坏都能从另一页恢复；页尾剩余空间可以存日志。

## 0x70 选项字节与读保护

选项字节（0x1FFFF800）控制芯片级行为：

| 位 | 名称 | 作用 |
| -- | ---- | ---- |
| RDP | 读保护 | 保护后调试器/ISP 读不到 Flash |
| WRP0~3 | 写保护 | 每位保护 4 个页 |
| USER | 用户选项 | 硬件看门狗、复位进 Stop/Standby |
| Data0/1 | 用户数据 | 两个自由字节 |

### 0x71 读保护

- RDP = 0x00A5：无保护；
- RDP 其它值：读保护（Level 1）；
- 解除保护会**全片擦除**，这是设计行为。

```c
/* 读选项字节 */
uint16_t rdp = FLASH_GetReadOutProtectionStatus();
```

量产时打开读保护，调试阶段别开。

### 0x72 写保护

`WRP0~3` 每一位保护 4 个页（中容量）。写保护后，擦除/编程会置 `WRPRTERR`。

### 0x73 选项字节操作

```c
FLASH_Unlock();
FLASH_EraseOptionBytes();
FLASH_ProgramOptionByteData(0x1FFFF804, 0x00);   /* Data0 */
FLASH_Lock();
```

选项字节操作风险高，写错可能导致芯片锁死；不确定时用 ST-LINK Utility 图形界面改。

### 0x74 选项字节代码

```c
void OptionBytes_Test(void)
{
    FLASH_Unlock();
    FLASH_EraseOptionBytes();

    /* Data0 = 0x5A，Data1 = 0xA5 */
    FLASH_ProgramOptionByteData(0x1FFFF804, 0x5A);
    FLASH_ProgramOptionByteData(0x1FFFF805, 0xA5);

    FLASH_Lock();

    uint8_t d0 = FLASH_ReadOptionByte(0x1FFFF804) & 0xFF;
    uint8_t d1 = FLASH_ReadOptionByte(0x1FFFF805) & 0xFF;
    printf("Data0=%02X Data1=%02X\r\n", d0, d1);
}
```

### 0x75 量产流程

1. 全片擦除；
2. 烧录固件；
3. 写用户数据/序列号；
4. 打开读保护；
5. 复位、自检、贴标。

读保护打开后，重新烧录必须先解除（会全擦）；产线要有对应流程，避免“以为坏了”。

### 0x76 选项字节的风险

- 写错 RDP 等级可能“锁死”；
- 写保护配错会导致“程序能跑但参数写不进”；
- 选项字节擦除后要重新上电才完全生效；
- 不同型号的选项字节布局不同，别照抄。

安全做法：

1. 先用 ST-LINK Utility 图形界面确认；
2. 代码里先读、备份、再改；
3. 产线有“解锁/全擦”的恢复流程。

## 0x80 芯片 ID 与 UID

### 0x81 DEV_ID

```c
uint16_t dev_id = (*(__IO uint32_t *)0xE0042000) & 0x0FFF;
```

F103 中容量 DEV_ID = 0x410；不同容量/系列不同。

### 0x82 Flash 容量

```c
uint16_t flash_size = *(__IO uint16_t *)0x1FFFF7E0;   /* 单位 KB */
```

C8T6 读出 64。

### 0x83 96 位唯一 ID

```c
uint32_t uid[3];
uid[0] = *(__IO uint32_t *)0x1FFFF7E8;
uid[1] = *(__IO uint32_t *)0x1FFFF7EC;
uid[2] = *(__IO uint32_t *)0x1FFFF7F0;
```

UID 全球唯一，可做：

- 设备序列号；
- 授权/加密绑定；
- 防止固件被复制到别的板子。

### 0x84 用 UID 做设备绑定

```c
uint32_t GetDeviceKey(void)
{
    uint32_t uid0 = *(__IO uint32_t *)0x1FFFF7E8;
    uint32_t uid1 = *(__IO uint32_t *)0x1FFFF7EC;

    return uid0 ^ (uid1 * 2654435761u);   /* 简单混合 */
}
```

用途：

- 授权码与 UID 绑定，换板子就失效；
- 加密通信的初始密钥；
- 设备序列号（打印/二维码）。

注意：UID 不是“安全芯片”，能读出来；高安全场景要外挂 SE/加密芯片。

### 0x85 常见 DEV_ID

| 型号 | DEV_ID | Flash |
| ---- | ------ | ----- |
| F103x6 | 0x412 | 32 KB |
| F103x8/B | 0x410 | 64/128 KB |
| F103xC/D/E | 0x414 | 256/384/512 KB |
| F105/F107 | 0x418 | 256 KB |

读 DEV_ID 可以区分“焊的是哪颗”，产线防错料。

## 0x90 实验与调试

### 0x91 读写参数实验

- 第一次上电：`Load FAIL`，写默认值并保存；
- 复位后再上电：`Load OK`，数据还在；
- 改 `Param.Data[0]` 再保存，复位后应保留。

### 0x92 擦除实验

- 不擦除直接写：新数据与旧数据按位与，读出“混合值”；
- 擦除后再写：读出正确；
- 全片擦除后：全 0xFF。

### 0x93 寿命与磨损

- 每次保存都擦一页，1 万次后该页可能失效；
- 参数变化不频繁（一天几次）可用十几年；
- 频繁写用双页轮换/EEPROM。

### 0x94 掉电测试

保存过程中掉电，可能只写了一半。用 magic + CRC 判断：

- CRC 不对 → 用默认值；
- 双页轮换 → 保留上一份有效数据。

### 0x95 用 Flash 存日志

日志是“追加写、很少擦”：把一页分成 N 条记录，写满再擦下一页。

```c
typedef struct
{
    uint32_t Timestamp;
    uint16_t Event;
    uint16_t Crc;
} LogRecord;

void Log_Append(uint32_t Timestamp, uint16_t Event)
{
    static uint32_t Offset = 0;
    LogRecord Rec = {Timestamp, Event, 0};

    Rec.Crc = Param_CRC16((uint8_t *)&Rec, sizeof(Rec) - 2);

    if (Offset + sizeof(Rec) > 1024)     /* 页满 */
    {
        Offset = 0;
        MyFLASH_ErasePage(LOG_PAGE);
    }

    MyFLASH_WriteBuffer(LOG_PAGE + Offset, (uint8_t *)&Rec, sizeof(Rec));
    Offset += sizeof(Rec);
}
```

读日志时从后往前找 CRC 正确的记录。

### 0x96 寿命估算

```text
寿命（年） = 擦写次数 / (每天保存次数 × 365)
```

1 万次、每天保存 10 次：约 2.7 年；每天 1 次：约 27 年。频繁保存要：

- 双页轮换；
- 只在参数变化时保存；
- 加掉电检测，避免反复写；
- 换 EEPROM/FRAM。

### 0x97 数据恢复

参数区读不出来时：

1. 先判断是“数据无效”还是“Flash 坏”；
2. 无效：用默认值/双页备份；
3. Flash 坏：换页、标记坏页；
4. 全片擦除是最后手段（会丢程序）。

```c
if (!Param_Load(&Param))
{
    if (!Param_Load_Backup(&Param))   /* 另一页 */
    {
        Param = DefaultParam;
    }
}
```

双页/双备份是低成本高收益的设计。

### 0x98 调试建议

- 用 ST-LINK Utility 直接看 Flash 内容，确认写没写进去；
- 用 `printf` 打印 FLASH_SR 状态；
- 擦写前后关中断，排除中断干扰；
- 先在小页/测试页验证，再动参数区；
- 保留一份“出厂固件 + 参数”，方便恢复。

### 0x99 工程文件组织

```text
MyFLASH.c/h    读写擦底层
Param.c/h      参数结构、CRC、双页轮换
main.c         业务
```

分层的好处：换存储介质（内部 Flash → EEPROM/外部 Flash）只改底层，上层不动。

## 0xA0 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| 写进去读出来 0xFF | 没擦除/没解锁 | 先擦后写，检查 KEYR |
| 写进去是 0x0000 | 地址错/写保护 | 查地址、WRP |
| 擦除后程序跑飞 | 擦了代码页 | 参数区避开程序区 |
| 擦除时死机 | 擦除期间取指/中断 | 关中断、别在 Flash 里执行 |
| PGERR 置位 | 写非 0xFF 位置 | 整页擦除后再写 |
| WRPRTERR | 写了写保护页 | 解除 WRP |
| 写一半掉电 | 没做掉电保护 | magic + CRC + 双页 |
| 参数偶尔丢 | 擦除/写入未完成 | 等 BSY/EOP，加校验 |
| 读保护后连不上 | RDP 生效 | ISP 解除（会全擦） |
| UID 全 0 | 地址错 | F103 是 0x1FFFF7E8 |
| 32 位写错 | 只支持半字 | 拆两个半字 |
| 寿命到了 | 擦写超 1 万次 | 换页/换 EEPROM |

## 0xB0 小结

| 操作 | 关键点 |
| ---- | ------ |
| 读 | 指针直接访问，`__IO` 防优化 |
| 解锁 | KEY1/KEY2，顺序不能错 |
| 擦除 | 按页，PER + AR + STRT |
| 编程 | 按半字，PG + 写地址 |
| 保护 | RDP 全片、WRP 按页 |
| ID | DEV_ID + 96 位 UID |
| 参数 | magic + 版本 + CRC + 双页 |

### 思考题

1. 为什么 Flash 写之前必须擦除？
2. 半字编程为什么地址必须是偶数？
3. 读保护解除为什么要全片擦除？
4. 参数存储怎么防“写一半掉电”？
5. 什么时候该用内部 Flash，什么时候该用 EEPROM？

内部 Flash 当参数区用，核心就三句话：**先擦后写、半字对齐、别擦到代码**。把这三点守住，它就是一个不用外挂芯片的小硬盘。
