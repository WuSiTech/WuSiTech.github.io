+++
title = "STM32 USART：协议、外设、收发、printf 与 DMA 接收"
date = "2026-11-01T19:30:00+08:00"
lastmod = "2026-11-06T23:55:00+08:00"
draft = false
description = "以 STM32F103C8T6 与标准外设库为例，从 TTL/RS232/RS485 电平、帧格式、波特率误差讲起，吃透 USART 的 SR/DR/BRR、发送与接收流程、中断与错误标志，再给出轮询发送、printf 重定向、中断接收环形缓冲、DMA+IDLE 不定长接收的完整 .h/.c/main.c 代码。"
categories = [ "STM32" ]
tags = [ "STM32", "USART", "串口", "通信" ]
cover = "/images/pool/covers/covers-09.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 9 章前半（9-1 ~ 9-3）。

代码基于 **STM32F103C8T6 + STM32F10x 标准外设库 3.5.0**（API 已按 STM32F10x StdPeriph 3.5 头文件核对；Delay/OLED/Key 为课程配套驱动），不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 9-1 | 通信接口、串口通信、硬件电路、电平标准、串口参数及时序、逻辑分析仪看时序 | 0x00 ~ 0x30 |
| 9-2 | USART 外设简介、框图、寄存器、波特率、发送/接收流程、中断 | 0x30 ~ 0x40 |
| 9-3 | 串口发送、串口发送 + 接收（代码） | 0x50 ~ 0x60 |

视频之外还补了：波特率误差计算、环形缓冲、DMA + IDLE 不定长接收、错误标志处理、RS485 半双工、多机地址唤醒、12 条故障排查。

## 0x00 通信接口全景

单片机的引脚有限，外设却越来越多，所以需要“通信”把外面的事情交给别的芯片。常见接口：

| 接口 | 引脚 | 双工 | 时钟 | 电平 | 设备 |
| ---- | ---- | ---- | ---- | ---- | ---- |
| USART | TX、RX | 全双工 | 异步 | 单端 | 点对点 |
| I2C | SCL、SDA | 半双工 | 同步 | 单端 | 多设备 |
| SPI | SCK、MOSI、MISO、CS | 全双工 | 同步 | 单端 | 多设备 |
| CAN | CAN_H、CAN_L | 半双工 | 异步 | 差分 | 多设备 |
| USB | DP、DM | 半双工 | 异步 | 差分 | 点对点 |

串口（USART/UART）是最古老、最便宜的通信方式：两根线、按位发、不需要时钟线，几乎所有模块都支持。

“异步”意味着没有单独的时钟线，收发双方靠**事先约定好的波特率**对时。这也解释了串口为什么“波特率一对不上就全是乱码”。

## 0x10 串口的电气

### 0x11 硬件连接

![串口硬件连接](/images/posts/stm32-usart/usart-circuit.webp)

- 双向通信需要两根线：发送端 **TX**、接收端 **RX**；
- 两边的 TX/RX 要**交叉**连接：A 的 TX 接 B 的 RX，A 的 RX 接 B 的 TX；
- 只需要单向传输时，可以只接一根线；
- 两边必须**共地**（GND 相连），否则电平没有共同参考点；
- 电平标准不一致时，要加电平转换芯片（比如 MAX3232）。

接电脑通常用 **USB 转 TTL**（CH340、CP2102、FT232）。注意：

- 模块的 VCC 电平要跟单片机一致（3.3 V 或 5 V），不要混用；
- 如果单片机已经由别处供电，USB-TTL 的 VCC 不要再接（只接 TX/RX/GND）；
- 有些模块 TX/RX 标反了，接之前先用万用表/示波器确认。

### 0x12 电平标准

串口只规定了“位”的时序，没有规定“位”用什么电压表示：

| 标准 | 逻辑 1 | 逻辑 0 | 特点 |
| ---- | ------ | ------ | ---- |
| TTL | 3.3 V / 5 V | 0 V | 单片机、模块之间直接用 |
| RS232 | −3 ~ −15 V | +3 ~ +15 V | 抗干扰好、传输远，需转换芯片，且**反相** |
| RS485 | 两线压差 +2 ~ +6 V | 压差 −2 ~ −6 V | 差分、抗干扰强、可多点，适合工业现场 |

TTL 直接连 RS232 会烧口；RS232 的“负逻辑”也容易让初学者误判。RS485 是**半双工**，需要一根方向控制脚（DE/RE）切换收发。

## 0x20 帧格式

### 0x21 一帧长什么样

![串口帧格式](/images/posts/stm32-usart/usart-frame.webp)

- **起始位**：固定低电平，告诉对方“要开始了”；
- **数据位**：5 ~ 9 位，**低位在前**（LSB first）；
- **校验位**：奇校验/偶校验/无校验，只能发现单比特错误；
- **停止位**：固定高电平，0.5 / 1 / 1.5 / 2 位；
- **空闲**：停止位之后保持高电平，直到下一个起始位。

最常见的配置是 **9600-8-N-1**：1 位起始 + 8 位数据 + 无校验 + 1 位停止，一帧 10 位。9600 波特率下，一帧约 1.04 ms；115200 下约 86.8 µs。

校验位不是万能的：它只能发现奇数个位翻转，偶数个位同时出错就查不出来。要求高时用 CRC。

### 0x22 波特率与误差

STM32 的 USART 用 16 倍过采样，波特率由 `USART_BRR` 决定：

```text
USARTDIV = fPCLK / (16 × BaudRate)
BRR = 整数部分 << 4 | 小数部分 × 16
```

以 72 MHz、9600 为例：

```text
USARTDIV = 72 000 000 / (16 × 9600) = 468.75
整数 468，小数 0.75 × 16 = 12
BRR = 468 << 4 | 12 = 0x1D4C
```

115200 时：

```text
USARTDIV = 72 000 000 / (16 × 115200) = 39.0625
BRR = 39 << 4 | 1 = 0x271
```

标准库的 `USART_Init()` 会自动算 BRR。但要注意**时钟来源**：USART1 挂 APB2（72 MHz），USART2/3 挂 APB1（36 MHz）；用错总线，波特率会差一倍。

波特率误差来自时钟。用内部 RC（HSI）时误差可能到 ±1%，加上对方晶振的误差，总误差超过 3% 就容易丢帧。要求稳定时用外部晶振（HSE），并在高波特率下留余量。

### 0x23 常见帧配置

| 配置 | 帧长 | 适用 |
| ---- | ---- | ---- |
| 9600-8-N-1 | 10 位 | 模块默认、调试 |
| 115200-8-N-1 | 10 位 | 高速调试、短距离 |
| 9600-8-E-1 | 11 位 | 工业设备、抗干扰 |
| 115200-8-N-2 | 11 位 | 长线、容错 |

改配置时，收发双方必须**完全一致**：波特率、数据位、校验、停止位，一个都不能差。

### 0x24 校验位与 9 位数据

带校验位时，一帧变成 11 位：起始 + 8 数据 + 1 校验 + 停止。校验位由数据位异或得到：

- **偶校验**：数据位 + 校验位中 1 的个数为偶数；
- **奇校验**：1 的个数为奇数。

STM32 的 `USART_WordLength_9b` 把校验位算在 9 位里（8 数据 + 1 校验），所以配置校验时字长要选 9b，而不是 8b。很多人“开了校验就乱码”，就是字长没改。

```c
USART_InitStructure.USART_WordLength = USART_WordLength_9b;
USART_InitStructure.USART_Parity = USART_Parity_Even;
```

### 0x25 半双工与单线模式

F103 的 USART 支持半双工单线模式（`USART_HalfDuplexCmd(USART1, ENABLE)`），只用一根 TX 线做双向通信（类似单总线）。适合引脚紧张、距离很近的场合；调试时不如全双工直观，一般不用。

### 0x26 波特率误差能容忍多少

UART 是异步采样，每位在中间采样一次。接收方允许的累计误差大约是 **±2% ~ ±3%**（10 位帧、16 倍过采样）。误差来源：

```text
总误差 = 发送方时钟误差 + 接收方时钟误差 + 波特率分频取整误差
```

72 MHz、115200 时 `USARTDIV = 39.0625`，取 39 + 1/16 = 39.0625，分频误差为 0；如果时钟换成 8 MHz HSI，`USARTDIV = 4.34`，取整误差就有 1% 以上，再叠加 RC 的 ±1%，很容易超限。

所以高波特率、长距离、工业现场，优先用外部晶振，并把两边波特率都设成标准值。

## 0x30 STM32 的 USART 外设

### 0x31 资源与引脚

F103C8T6 有 3 个 USART：

| 外设 | 总线 | 默认引脚 | 重映射 |
| ---- | ---- | -------- | ------ |
| USART1 | APB2（72 MHz） | PA9(TX) / PA10(RX) | PB6/PB7 |
| USART2 | APB1（36 MHz） | PA2(TX) / PA3(RX) | PD5/PD6 |
| USART3 | APB1（36 MHz） | PB10(TX) / PB11(RX) | PC10/PC11 或 PD8/PD9 |

USART1 的重映射要开 AFIO 时钟并调 `GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE)`。

### 0x32 内部结构

USART 内部大致分三块：

- **发送**：`DR` → 发送移位寄存器 → TX 引脚，按波特率逐位输出；
- **接收**：RX 引脚 → 接收移位寄存器 → `DR`，按波特率采样；
- **控制/状态**：`CR1/CR2/CR3` 配置，`SR` 反映状态，`BRR` 决定波特率。

发送流程：

1. 把数据写进 `DR`；
2. 硬件把它移进移位寄存器，按位从 TX 发出去；
3. `TXE`（发送数据寄存器空）置 1，表示可以写下一个字节；
4. 最后一个字节发完，`TC`（发送完成）置 1。

接收流程：

1. RX 上检测到起始位，开始按波特率采样；
2. 收满一帧，数据进 `DR`，`RXNE`（读数据寄存器非空）置 1；
3. 读 `DR` 会清 `RXNE`；
4. 如果上一帧还没读走，新数据会覆盖，`ORE`（溢出）置 1。

### 0x33 关键寄存器

| 寄存器 | 作用 | 关键位 |
| ------ | ---- | ------ |
| `USART_SR` | 状态 | TXE、TC、RXNE、IDLE、ORE、PE、FE、NE |
| `USART_DR` | 数据 | 读=接收，写=发送 |
| `USART_BRR` | 波特率 | DIV_Mantissa[11:4]、DIV_Fraction[3:0] |
| `USART_CR1` | 控制 1 | UE、TE、RE、RXNEIE、TXEIE、TCIE、IDLEIE、PEIE、M、PCE、PS |
| `USART_CR2` | 控制 2 | STOP[1:0]、LINEN、CLKEN |
| `USART_CR3` | 控制 3 | DMAR、DMAT、RTSE、CTSE |

### 0x34 标志与中断

| 标志 | 含义 | 清除方式 | 常用中断 |
| ---- | ---- | -------- | -------- |
| TXE | 发送寄存器空 | 写 DR | TXEIE |
| TC | 发送完成 | 读 SR + 写 DR | TCIE |
| RXNE | 收到数据 | 读 DR | RXNEIE |
| IDLE | 总线空闲 | 读 SR + 读 DR | IDLEIE |
| ORE | 接收溢出 | 读 SR + 读 DR | RXNEIE |
| PE | 校验错 | 读 SR + 读 DR | PEIE |
| FE | 帧错误 | 读 SR + 读 DR | EIE |
| NE | 噪声 | 读 SR + 读 DR | EIE |

`ORE` 是最常见的“隐形杀手”：中断里只读 `DR` 不清 `SR`，或者中断被长时间关闭，都会让 `ORE` 置位，之后收到的数据全部错位。

## 0x40 硬件设计

### 0x41 USB-TTL 接线

```text
USB-TTL           STM32
TX      ────────  PA10 (RX)
RX      ────────  PA9  (TX)
GND     ────────  GND
3V3     ────────  （不接，板子已供电）
```

注意：

- TX/RX 一定要交叉；
- 共地是必须的，否则数据随机出错；
- 5 V 模块接 3.3 V 单片机前，确认引脚是否 5 V 容忍（F103 的 PA10 是 FT 引脚，但 PA9 不是，别接反）；
- 长线、强干扰场合用双绞线 + 屏蔽，或改 RS485。

### 0x42 RS232 与 RS485

**RS232**：单片机 TTL → MAX3232 → DB9，逻辑反相、电平 ±12 V；适合 15 m 内点对点。

**RS485**：单片机 TTL → MAX485 → A/B 差分线；半双工，需要 DE/RE 控制方向：

```c
void RS485_Send(uint8_t *Buf, uint16_t Len)
{
    GPIO_SetBits(GPIOA, GPIO_Pin_8);    /* DE = 1，发送 */
    for (uint16_t i = 0; i < Len; i++) Serial_SendByte(Buf[i]);
    while (USART_GetFlagStatus(USART1, USART_FLAG_TC) == RESET);
    GPIO_ResetBits(GPIOA, GPIO_Pin_8);  /* DE = 0，接收 */
}
```

RS485 总线两端要接 120 Ω 终端电阻，A/B 不能接反。

### 0x43 多机通信与地址唤醒

多个从机挂在同一对 RX/TX 上时，可以用 **9 位数据 + 地址位** 的“多机模式”：

- 第 9 位 = 1：地址帧，所有从机都收；
- 第 9 位 = 0：数据帧，只有被点名的从机收。

F103 支持地址唤醒（`USART_WakeUp_AddressMark`）和空闲唤醒（`USART_WakeUp_IdleLine`），用 `USART_WakeUpConfig()` 选择、`USART_SetAddress()` 设本机地址，再配合 `USART_ReceiverWakeUpCmd()` 控制是否进入静默。普通点对点通信不需要。

## 0x50 软件设计

本篇代码文件：

| 文件 | 作用 |
| ---- | ---- |
| `Serial.h` / `Serial.c` | USART1 初始化、发送、接收、环形缓冲 |
| `main.c` | 回显、printf、DMA 接收实验 |

### 0x51 初始化顺序

1. 开 USART1 时钟（APB2）和 GPIOA 时钟（APB2）；
2. PA9 配 `AF_PP`，PA10 配 `IPU`；
3. 填 `USART_InitTypeDef`：波特率、8 位、1 停止、无校验、收发模式；
4. `USART_Init()` 算 BRR；
5. 需要中断就 `USART_ITConfig()` + NVIC；
6. `USART_Cmd(ENABLE)`。

### 0x52 轮询发送完整代码

`Serial.h`：

```c
#ifndef __SERIAL_H
#define __SERIAL_H

#include "stm32f10x.h"
#include <stdio.h>

void Serial_Init(void);
void Serial_SendByte(uint8_t Byte);
void Serial_SendArray(uint8_t *Array, uint16_t Length);
void Serial_SendString(char *String);
void Serial_SendNumber(uint32_t Number, uint8_t Length);

uint8_t Serial_GetRxFlag(void);
uint8_t Serial_GetRxData(void);

#endif
```

`Serial.c`：

```c
#include "Serial.h"

void Serial_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    /* PA9 = TX，复用推挽 */
    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_9;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    /* PA10 = RX，上拉输入 */
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_10;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    USART_InitTypeDef USART_InitStructure;
    USART_InitStructure.USART_BaudRate = 9600;
    USART_InitStructure.USART_WordLength = USART_WordLength_8b;
    USART_InitStructure.USART_StopBits = USART_StopBits_1;
    USART_InitStructure.USART_Parity = USART_Parity_No;
    USART_InitStructure.USART_HardwareFlowControl = USART_HardwareFlowControl_None;
    USART_InitStructure.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    USART_Init(USART1, &USART_InitStructure);

    USART_ITConfig(USART1, USART_IT_RXNE, ENABLE);

    NVIC_PriorityGroupConfig(NVIC_PriorityGroup_2);
    NVIC_InitTypeDef NVIC_InitStructure;
    NVIC_InitStructure.NVIC_IRQChannel = USART1_IRQn;
    NVIC_InitStructure.NVIC_IRQChannelCmd = ENABLE;
    NVIC_InitStructure.NVIC_IRQChannelPreemptionPriority = 1;
    NVIC_InitStructure.NVIC_IRQChannelSubPriority = 1;
    NVIC_Init(&NVIC_InitStructure);

    USART_Cmd(USART1, ENABLE);
}

void Serial_SendByte(uint8_t Byte)
{
    USART_SendData(USART1, Byte);
    while (USART_GetFlagStatus(USART1, USART_FLAG_TXE) == RESET);
}

void Serial_SendArray(uint8_t *Array, uint16_t Length)
{
    for (uint16_t i = 0; i < Length; i++)
    {
        Serial_SendByte(Array[i]);
    }
}

void Serial_SendString(char *String)
{
    for (uint8_t i = 0; String[i] != '\0'; i++)
    {
        Serial_SendByte(String[i]);
    }
}

void Serial_SendNumber(uint32_t Number, uint8_t Length)
{
    for (uint8_t i = 0; i < Length; i++)
    {
        Serial_SendByte('0' + Number % 10);
        Number /= 10;
    }
}

/* 中断接收：一个字节 + 标志 */
static volatile uint8_t Serial_RxData;
static volatile uint8_t Serial_RxFlag;

uint8_t Serial_GetRxFlag(void)
{
    if (Serial_RxFlag == 1)
    {
        Serial_RxFlag = 0;
        return 1;
    }
    return 0;
}

uint8_t Serial_GetRxData(void)
{
    return Serial_RxData;
}

void USART1_IRQHandler(void)
{
    if (USART_GetITStatus(USART1, USART_IT_RXNE) == SET)
    {
        Serial_RxData = USART_ReceiveData(USART1);
        Serial_RxFlag = 1;
        USART_ClearITPendingBit(USART1, USART_IT_RXNE);
    }
}
```

`main.c`：

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "Serial.h"

int main(void)
{
    Serial_Init();

    Serial_SendString("Hello USART!\r\n");

    while (1)
    {
        if (Serial_GetRxFlag() == 1)
        {
            Serial_SendByte(Serial_GetRxData());   /* 回显 */
        }
    }
}
```

### 0x53 printf 重定向

在 Keil 里重定向 `fputc`，就能直接用 `printf`。记得勾选 **Use MicroLIB**：

```c
int fputc(int ch, FILE *f)
{
    Serial_SendByte(ch);
    return ch;
}
```

```c
printf("Num=%d, Volt=%.2f\r\n", 123, 1.23f);
```

如果不用 MicroLIB，标准库会调用 `_write`，需要自己实现：

```c
int _write(int fd, char *ptr, int len)
{
    for (int i = 0; i < len; i++)
    {
        Serial_SendByte(ptr[i]);
    }
    return len;
}
```

`printf` 默认阻塞发送，115200 下影响不大；数据量大时用 DMA。

### 0x54 环形缓冲接收

一个字节一个标志，遇到连续数据会丢。更稳的做法是环形缓冲：

```c
#define RX_BUF_SIZE 64

static volatile uint8_t RxBuf[RX_BUF_SIZE];
static volatile uint16_t RxHead = 0;   /* 中断写 */
static volatile uint16_t RxTail = 0;   /* 主循环读 */

void USART1_IRQHandler(void)
{
    if (USART_GetITStatus(USART1, USART_IT_RXNE) == SET)
    {
        uint8_t Data = USART_ReceiveData(USART1);
        uint16_t Next = (RxHead + 1) % RX_BUF_SIZE;

        if (Next != RxTail)            /* 没满才写 */
        {
            RxBuf[RxHead] = Data;
            RxHead = Next;
        }

        USART_ClearITPendingBit(USART1, USART_IT_RXNE);
    }
}

uint8_t Serial_ReadByte(uint8_t *Byte)
{
    if (RxHead == RxTail) return 0;    /* 空 */

    *Byte = RxBuf[RxTail];
    RxTail = (RxTail + 1) % RX_BUF_SIZE;
    return 1;
}
```

主循环里不断取，取到一帧再解析；中断只负责“搬进缓冲”，不做耗时处理。

### 0x55 DMA + IDLE 不定长接收

固定长度用 DMA 很省事，但串口数据往往不定长。标准做法是 **DMA 循环接收 + IDLE 中断**：

```c
#define DMA_RX_SIZE 64

uint8_t DMA_RxBuf[DMA_RX_SIZE];
volatile uint16_t DMA_RxLen;

void Serial_DMA_Init(void)
{
    RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1, ENABLE);

    DMA_InitTypeDef DMA_InitStructure;
    DMA_InitStructure.DMA_PeripheralBaseAddr = (uint32_t)&USART1->DR;
    DMA_InitStructure.DMA_MemoryBaseAddr = (uint32_t)DMA_RxBuf;
    DMA_InitStructure.DMA_DIR = DMA_DIR_PeripheralSRC;
    DMA_InitStructure.DMA_BufferSize = DMA_RX_SIZE;
    DMA_InitStructure.DMA_PeripheralInc = DMA_PeripheralInc_Disable;
    DMA_InitStructure.DMA_MemoryInc = DMA_MemoryInc_Enable;
    DMA_InitStructure.DMA_PeripheralDataSize = DMA_PeripheralDataSize_Byte;
    DMA_InitStructure.DMA_MemoryDataSize = DMA_MemoryDataSize_Byte;
    DMA_InitStructure.DMA_Mode = DMA_Mode_Circular;
    DMA_InitStructure.DMA_Priority = DMA_Priority_Medium;
    DMA_InitStructure.DMA_M2M = DMA_M2M_Disable;
    DMA_Init(DMA1_Channel5, &DMA_InitStructure);   /* USART1_RX = Ch5 */
    DMA_Cmd(DMA1_Channel5, ENABLE);

    USART_DMACmd(USART1, USART_DMAReq_Rx, ENABLE);
    USART_ITConfig(USART1, USART_IT_IDLE, ENABLE);
}
```

IDLE 中断里算长度：

```c
void USART1_IRQHandler(void)
{
    if (USART_GetITStatus(USART1, USART_IT_IDLE) == SET)
    {
        /* 先读 SR 再读 DR，清 IDLE */
        volatile uint32_t Temp = USART1->SR;
        Temp = USART1->DR;
        (void)Temp;

        DMA_RxLen = DMA_RX_SIZE - DMA_GetCurrDataCounter(DMA1_Channel5);

        /* 这里可以置标志，主循环处理 DMA_RxBuf[0..DMA_RxLen-1] */
    }
}
```

注意：DMA 循环模式会“回卷”，如果一帧超过缓冲区，旧数据会被覆盖；要么加大缓冲，要么在 IDLE 里及时处理。

### 0x56 错误标志处理

```c
void USART1_IRQHandler(void)
{
    if (USART_GetFlagStatus(USART1, USART_FLAG_ORE) == SET)
    {
        /* 读 SR 再读 DR 清 ORE */
        volatile uint32_t Temp = USART1->SR;
        Temp = USART1->DR;
        (void)Temp;
        /* 记录一次溢出错误 */
    }

    if (USART_GetITStatus(USART1, USART_IT_RXNE) == SET)
    {
        uint8_t Data = USART_ReceiveData(USART1);
        /* 入环形缓冲 */
    }
}
```

`FE`（帧错误）通常是波特率不匹配或干扰；`NE`（噪声）是线路质量问题；`PE` 是校验错。三者都可以通过“读 SR + 读 DR”清除。

### 0x57 串口命令解析器

收到数据只是第一步，真正有用的是“把一行文本变成命令”。一个最小解析器：

```c
#include <string.h>

static char CmdBuf[32];
static uint8_t CmdLen;

void Serial_Poll(void)
{
    uint8_t Byte;

    while (Serial_ReadByte(&Byte))
    {
        if (Byte == '\r') continue;

        if (Byte == '\n')
        {
            CmdBuf[CmdLen] = '\0';

            if (strcmp(CmdBuf, "LED ON") == 0)
            {
                GPIO_ResetBits(GPIOC, GPIO_Pin_13);   /* 低电平点亮 */
            }
            else if (strcmp(CmdBuf, "LED OFF") == 0)
            {
                GPIO_SetBits(GPIOC, GPIO_Pin_13);
            }
            else if (strcmp(CmdBuf, "RESET") == 0)
            {
                NVIC_SystemReset();
            }
            else if (CmdLen > 0)
            {
                Serial_SendString("ERR\r\n");
            }

            CmdLen = 0;
        }
        else if (CmdLen < sizeof(CmdBuf) - 1)
        {
            CmdBuf[CmdLen++] = Byte;
        }
        else
        {
            CmdLen = 0;   /* 超长，丢弃这一行 */
        }
    }
}
```

主循环里每 1 ms 调一次 `Serial_Poll()`，就能用串口助手发命令控制板子。命令解析要注意：

- 行尾统一（`\r\n` 或 `\n`），别混用；
- 缓冲区有上限，超长直接丢弃；
- 不要在中断里 `strcmp`/`printf`，解析放主循环。

### 0x58 串口超时与断帧

通信协议里“一帧结束”有时不是换行，而是“一段时间没有新字节”。可以用定时器做超时：

```c
#define FRAME_MAX 64

static uint8_t FrameBuf[FRAME_MAX];
static volatile uint8_t FrameReady;
static uint8_t FrameLen;
static uint16_t LastTick;

void Serial_TimeoutPoll(void)
{
    uint8_t Byte;

    while (Serial_ReadByte(&Byte))
    {
        if (FrameLen < FRAME_MAX)
        {
            FrameBuf[FrameLen++] = Byte;
        }
        LastTick = 0;                     /* 收到字节就清零 */
    }

    LastTick++;
    if (FrameLen > 0 && LastTick > 20)    /* 20ms 没有新字节 */
    {
        FrameReady = 1;
        LastTick = 0;
    }
}
```

配合 1 ms 的 SysTick 或定时器中断，就能实现“3.5 个字符时间”之类的 Modbus 风格断帧。

### 0x59 串口 DMA 发送

数据量大时（日志、波形、图片），`printf` 的逐字节阻塞会拖慢主循环，改用 DMA：

```c
void Serial_DMATx_Init(void)
{
    RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1, ENABLE);

    DMA_InitTypeDef DMA_InitStructure;
    DMA_InitStructure.DMA_PeripheralBaseAddr = (uint32_t)&USART1->DR;
    DMA_InitStructure.DMA_MemoryBaseAddr = 0;      /* 发送时再设 */
    DMA_InitStructure.DMA_DIR = DMA_DIR_PeripheralDST;
    DMA_InitStructure.DMA_BufferSize = 0;
    DMA_InitStructure.DMA_PeripheralInc = DMA_PeripheralInc_Disable;
    DMA_InitStructure.DMA_MemoryInc = DMA_MemoryInc_Enable;
    DMA_InitStructure.DMA_PeripheralDataSize = DMA_PeripheralDataSize_Byte;
    DMA_InitStructure.DMA_MemoryDataSize = DMA_MemoryDataSize_Byte;
    DMA_InitStructure.DMA_Mode = DMA_Mode_Normal;
    DMA_InitStructure.DMA_Priority = DMA_Priority_Medium;
    DMA_InitStructure.DMA_M2M = DMA_M2M_Disable;
    DMA_Init(DMA1_Channel4, &DMA_InitStructure);   /* USART1_TX = Ch4 */

    USART_DMACmd(USART1, USART_DMAReq_Tx, ENABLE);
}

void Serial_DMATx_Send(uint8_t *Buffer, uint16_t Length)
{
    while (DMA_GetFlagStatus(DMA1_FLAG_TC4) == RESET && DMA1_Channel4->CNDTR != 0);

    DMA_Cmd(DMA1_Channel4, DISABLE);
    DMA1_Channel4->CMAR = (uint32_t)Buffer;
    DMA_SetCurrDataCounter(DMA1_Channel4, Length);
    DMA_Cmd(DMA1_Channel4, ENABLE);
}
```

要点：

- 发送期间不能改 `Buffer`；
- 连续发送要等上一帧 `TC4`，或者用双缓冲；
- DMA 只负责搬到 `DR`，最后的 `TC` 标志仍要等 USART 发完再切 RS485 方向。

## 0x60 实验与调试

### 0x61 回显实验

接线：USB-TTL 的 TX→PA10、RX→PA9、GND→GND。

现象：串口助手选 9600-8-N-1，打开串口，先收到 `Hello USART!`，之后每发一个字符就回显一个。

### 0x62 逻辑分析仪看时序

把逻辑分析仪接到 TX 上，采样率至少 1 MHz，解码器选 UART（9600、8N1）。发 `0x55`（二进制 01010101），应该看到：

```text
起始位(低) + 10101010（LSB 先发，所以是 0x55 的位反转）+ 停止位(高)
```

用示波器量一位宽度：9600 时约 104 µs，115200 时约 8.68 µs。位宽不对，就是波特率/时钟算错了。

### 0x63 波特率误差实验

把 USART1 的时钟源改成 HSI（8 MHz），波特率仍设 9600，观察误码率；再换回 HSE，对比。可以直观看到“时钟精度决定通信距离”。

### 0x64 长线/干扰

- 线长超过 1 m 时，降低波特率到 9600；
- 双绞线 + 共地；
- 必要时加 TVS/磁珠；
- 工业现场直接上 RS485。

### 0x65 串口 IAP 升级思路

产品出厂后要更新固件，串口是最低成本的通道。思路是把 Flash 分成两段：

```text
0x08000000 ~ 0x08003FFF  BootLoader（16KB）
0x08004000 ~ ...         APP（用户程序）
```

BootLoader 上电后：

1. 等 1 ~ 3 秒，看串口有没有升级命令；
2. 没有就跳转到 APP；
3. 有就接收固件、擦写 Flash、校验、跳转。

跳转代码：

```c
typedef void (*pFunction)(void);

void JumpToApp(uint32_t AppAddress)
{
    uint32_t JumpAddress = *(__IO uint32_t *)(AppAddress + 4);
    pFunction Jump = (pFunction)JumpAddress;

    __disable_irq();
    SCB->VTOR = AppAddress;       /* 向量表偏移 */
    __set_MSP(*(__IO uint32_t *)AppAddress);
    Jump();
}
```

APP 的链接地址要改成 `0x08004000`，并在 `system_stm32f10x.c` 里把 `VECT_TAB_OFFSET` 设为 `0x4000`，否则中断会跳到 BootLoader 的向量表。

升级协议可以很简单：`0xAA + 长度 + 数据 + 校验`，收到一包写一页；也可以直接用 XMODEM/YMODEM。关键是**先擦后写、写后校验、失败可重试**。

## 0x70 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| 完全没数据 | TX/RX 没交叉、没共地、USART 没使能 | 查线序、`USART_Cmd` |
| 收到乱码 | 波特率/数据位/校验/停止位不一致 | 两边配置完全一致 |
| 只能收不能发 | PA9 没配 AF_PP、USART 时钟错 | 检查 GPIO 模式和 APB 总线 |
| 只能发不能收 | PA10 没配输入、RX 没使能 | `USART_Mode_Rx`、`GPIO_Mode_IPU` |
| 偶尔丢字节 | 中断被关太久、没环形缓冲 | 提高中断优先级、加缓冲 |
| ORE 常置位 | 读数据太慢 | 加 DMA/环形缓冲，读 SR+DR 清 |
| printf 卡死 | 没勾 MicroLIB、没重定向 | 勾 MicroLIB 或实现 `_write` |
| 5 V 模块接上没反应 | 电平不匹配/引脚不耐 5 V | 加电平转换 |
| 高波特率误码 | 时钟误差、线太长 | 用 HSE、降速、缩短线 |
| DMA 接收长度不对 | 没清 IDLE、缓冲区回卷 | 读 SR+DR、加大缓冲 |
| RS485 发不出去 | DE 没拉高/没等 TC | 发送前拉高 DE，发完等 TC 再拉低 |
| 多机通信全响应 | 没开地址唤醒、第 9 位没配 | 配 9 位 + `USART_SetAddress` |

## 0x80 小结

| 项目 | 要点 |
| ---- | ---- |
| 接线 | TX/RX 交叉、共地、电平匹配 |
| 帧格式 | 起始 + 数据（LSB 先行）+ 校验 + 停止 |
| 波特率 | `fPCLK / (16 × baud)`，误差来自时钟 |
| 发送 | 写 DR，等 TXE；最后一字节等 TC |
| 接收 | RXNE 中断，读 DR 清除 |
| 大量数据 | 环形缓冲 / DMA + IDLE |
| 调试 | 先 9600-8-N-1，能通再提速 |

### 思考题

1. 72 MHz、115200 时 BRR 是多少？误差多大？
2. 为什么 TXE 和 TC 要分开？什么时候等 TXE，什么时候等 TC？
3. 环形缓冲的“满”和“空”为什么要留一个空位？
4. DMA + IDLE 接收时，如果一帧长度正好等于缓冲区大小，会发生什么？
5. RS485 为什么必须等 TC 才能切回接收？

串口是嵌入式里最可靠的“printf 调试器”。把发送、接收、重定向、缓冲这四件事跑通，后面 I2C、SPI、上位机通信都会轻松很多。
