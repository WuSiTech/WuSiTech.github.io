+++
title = "STM32 串口数据包：HEX/文本协议、状态机、校验与串口下载"
date = "2026-11-02T19:30:00+08:00"
lastmod = "2026-11-06T23:59:00+08:00"
draft = false
description = "从裸字节的粘包/半包问题讲起，设计固定长度 HEX 包、变长包、文本包与校验，用三状态机 + 环形缓冲实现可靠接收；再讲 BOOT0/BOOT1 启动模式、FlyMcu 串口下载、ST-LINK 与选项字节，附完整 .h/.c/main.c 代码与 12 条故障排查。"
categories = [ "STM32" ]
tags = [ "STM32", "USART", "串口", "数据包", "ISP" ]
cover = "/images/pool/covers/covers-10.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 9 章后半（9-4、9-5、9-6）。

代码基于 **STM32F103C8T6 + 标准外设库 3.5.0**，不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 9-4 | 数据包格式（固定/变长 HEX、文本）、状态机接收、校验 | 0x00 ~ 0x30 |
| 9-5 | 串口收发 HEX 数据包、串口收发文本数据包（代码） | 0x40、0x60 |
| 9-6 | FlyMcu 串口下载、STLINK Utility、选项字节 | 0x50 |

视频之外还补了：CRC16 校验、变长包转义、应答/重传、环形缓冲 + 状态机结合、ISP 协议细节、读保护与量产注意事项、12 条故障排查。

## 0x00 为什么裸字节不够

串口一次只给你一个字节。如果上位机连续发：

```text
01 02 03 04 05 06
```

从机怎么知道这是“两个 3 字节命令”还是“一个 6 字节命令”？如果中间丢了一个字节，又怎么发现？

实际通信里必须把字节组织成**数据包（帧）**：

- **边界**：包头/包尾/长度，让接收方知道从哪开始、到哪结束；
- **长度**：数据有多长；
- **校验**：数据有没有错；
- **超时**：一帧没收完怎么办。

串口是字节流，没有“消息边界”。不设计协议，就只能靠“刚好一次中断收一包”的运气——而中断可能一次收半个包，也可能一次收两个包。

## 0x10 数据包设计

### 0x11 固定长度 HEX 包

课程里最常用的格式：

![HEX 数据包的固定长度与可变长度](/images/posts/stm32-usart-packet/packet-format.webp)

```text
0xFF  D0 D1 D2 D3  0xFE
包头      4 字节数据     包尾
```

一包固定 6 字节。接收方看到 `0xFF` 就开始收 4 个数据，再等 `0xFE` 收尾。

优点：解析简单，状态机只要 3 个状态，RAM 占用小。
缺点：数据长度固定，不灵活；数据里如果出现 `0xFE`，会被误判成包尾。

### 0x12 可变长度 HEX 包

```text
0xFF  LEN  D0 D1 ... D(LEN-1)  CHECK  0xFE
```

多一个长度字节，就能收不定长数据。但“数据里出现包头/包尾”的问题依然存在，严谨的协议要么：

- **转义**：把数据里的 `0xFE` 写成 `0xFD 0x02`，`0xFD` 写成 `0xFD 0x01`；
- **长度字段 + 校验**：不靠包尾判断，收满 `LEN` 个再校验；
- **SLIP/COBS**：更系统的转义编码。

课程里的变长包只演示了“长度 + 包尾”，工程上建议至少加校验，别只靠包尾。

### 0x13 文本数据包

![文本数据包](/images/posts/stm32-usart-packet/packet-text.webp)

```text
'@'  'L' 'E' 'D' '_' 'O' 'N'  '\r' '\n'
包头            字符串内容          包尾
```

文本包的好处是**人可读**，串口助手直接就能发；坏处是效率低、解析要做字符串处理，数字要转 ASCII。

适合：调试命令、参数设置、日志。
不适合：高速数据、二进制传感器流。

### 0x14 校验

最简单的两种：

```c
/* 异或校验 */
uint8_t checksum = 0;
for (uint8_t i = 0; i < 4; i++) checksum ^= Data[i];

/* 累加和校验（取低 8 位） */
uint8_t sum = 0;
for (uint8_t i = 0; i < 4; i++) sum += Data[i];
```

异或能发现单比特错误，累加和能发现大部分随机错误；要更强就用 **CRC16**：

```c
uint16_t CRC16_Modbus(uint8_t *Buf, uint16_t Len)
{
    uint16_t Crc = 0xFFFF;

    for (uint16_t i = 0; i < Len; i++)
    {
        Crc ^= Buf[i];
        for (uint8_t j = 0; j < 8; j++)
        {
            if (Crc & 0x0001) Crc = (Crc >> 1) ^ 0xA001;
            else              Crc >>= 1;
        }
    }

    return Crc;
}
```

注意：**校验一般只算载荷**（或“长度 + 载荷”），不算包头包尾，收发两端必须约定一致。

### 0x15 协议设计清单

设计一个串口协议，至少回答这几个问题：

| 问题 | 选择 |
| ---- | ---- |
| 边界怎么定 | 包头/包尾、长度字段、转义 |
| 定长还是变长 | 固定命令用定长，数据流用变长 |
| 校验方式 | 异或/累加/CRC16 |
| 字节序 | 大端还是小端 |
| 超时 | 多少 ms 没收到就算断帧 |
| 应答 | 收到后回 ACK 还是静默 |
| 重传 | 丢了怎么办，序号/重发次数 |
| 最大长度 | 缓冲区上限，超了丢弃 |

课程里的 HEX 包只解决了“边界 + 固定长度”，工程上通常还要加“长度 + 校验 + 序号 + 应答”。

### 0x16 字节序与浮点传输

串口一次只能发一个字节，16 位/32 位数据要拆开。**先发高字节还是低字节**必须约定，否则 0x1234 会被拼成 0x3412。

```c
/* 大端：先发高字节 */
Serial_SendByte((Value >> 8) & 0xFF);
Serial_SendByte(Value & 0xFF);

/* 小端：先发低字节 */
Serial_SendByte(Value & 0xFF);
Serial_SendByte((Value >> 8) & 0xFF);
```

浮点数不能直接按位发（不同编译器格式可能不同），常用两种做法：

```c
typedef union
{
    float f;
    uint8_t b[4];
} FloatBytes;

FloatBytes v;
v.f = 3.14f;
Serial_SendArray(v.b, 4);   /* 接收端按同样的 union 还原 */
```

或者发“整数 + 小数点位置”，比如 3.14 发成 `314` 和 `2`，跨平台最稳。

### 0x17 一包数据在状态机里怎么走

以 `FF 01 02 03 04 FE` 为例：

| 收到字节 | 当前状态 | 动作 | 新状态 |
| -------- | -------- | ---- | ------ |
| FF | S0 | 清计数 | S1 |
| 01 | S1 | 存 Data[0] | S1 |
| 02 | S1 | 存 Data[1] | S1 |
| 03 | S1 | 存 Data[2] | S1 |
| 04 | S1 | 存 Data[3]，计数满 | S2 |
| FE | S2 | 置完成标志 | S0 |

如果第 5 个字节不是 `FE`，S2 会丢弃整包回 S0；如果中途来了新的 `FF`，S1 会把它当普通数据存进去——这是固定长度协议的一个坑：**数据里不能出现 `FF`/`FE`**，否则要转义。

### 0x18 吞吐与包长

串口的有效吞吐 = 波特率 / 10（8N1 每字节 10 位）：

| 波特率 | 字节/秒 | 6 字节包/秒 | 32 字节包/秒 |
| ------ | ------- | ----------- | ------------ |
| 9600 | 960 | 约 160 | 约 30 |
| 115200 | 11520 | 约 1920 | 约 360 |
| 460800 | 46080 | 约 7680 | 约 1440 |

包越短，协议开销占比越大；包越长，单包出错重传的代价越大。工程上常用 16 ~ 64 字节的载荷，兼顾效率和容错。

如果数据率接近上限，就要考虑：

- 提高波特率（注意时钟误差和线长）；
- 用 DMA 收發，减少中断开销；
- 改用 SPI/CAN/以太网。

## 0x20 接收状态机

![HEX 数据包接收状态机](/images/posts/stm32-usart-packet/packet-fsm.webp)

固定长度 HEX 包只需要 3 个状态：

| 状态 | 含义 | 收到什么转到哪 |
| ---- | ---- | -------------- |
| S0 | 等待包头 | 收到 `0xFF` → S1，清计数 |
| S1 | 接收数据 | 每收 1 字节存数组；收满 4 个 → S2 |
| S2 | 等待包尾 | 收到 `0xFE` → 置完成标志，回 S0 |
| 任意 | 异常 | 超时/长度错 → 回 S0 |

状态转移表：

| 当前 | 输入 | 下一状态 | 动作 |
| ---- | ---- | -------- | ---- |
| S0 | 0xFF | S1 | 计数清零 |
| S0 | 其它 | S0 | 丢弃 |
| S1 | 任意 | S1/S2 | 存数据，计数 +1 |
| S2 | 0xFE | S0 | 置完成标志 |
| S2 | 其它 | S0 | 丢弃整包（可选） |

三个工程要点：

1. **中断里只做“收”**：状态机 + 存数组，几十条指令；解析、控制、打印放主循环。
2. **完成标志由主循环清**：中断置 `RxFlag`，主循环处理完清零；处理期间新包来了也不会被覆盖（除非你希望覆盖）。
3. **要有超时/复位**：收到一半断了，状态机会卡在 S1；主循环检测“多久没收到新字节”，超时复位。

### 0x21 粘包、半包与超时

- **粘包**：一次中断收到两包，状态机会连续处理，第二包覆盖第一包——要么加缓冲，要么处理完再收。
- **半包**：一次只收到半包，状态机停在 S1，等下一批字节，没问题。
- **断包**：收到一半没下文，必须靠超时复位，否则后面的包永远接不上。

超时实现（1 ms 节拍）：

```c
static uint16_t IdleTick;

void Serial_Tick(void)          /* 1ms 调一次 */
{
    if (RxState != 0)
    {
        IdleTick++;
        if (IdleTick > 50)      /* 50ms 没新字节 */
        {
            RxState = 0;
            IdleTick = 0;
        }
    }
}
```

### 0x22 中断 + 主循环分层

```text
中断：字节 → 状态机 → 完成标志
主循环：标志 → 校验 → 解析 → 执行 → 清标志
```

中断里绝对不要 `printf`、`strcmp`、Flash 擦写、延时；这些都会让中断变长，导致丢字节。

### 0x23 环形缓冲 + 状态机

中断里直接跑状态机，遇到“解析耗时”就会丢字节。更稳的是中断只入环形缓冲，主循环再跑状态机：

```c
#define RX_BUF_SIZE 64

static volatile uint8_t RxBuf[RX_BUF_SIZE];
static volatile uint16_t RxHead, RxTail;

void USART1_IRQHandler(void)
{
    if (USART_GetITStatus(USART1, USART_IT_RXNE) == SET)
    {
        uint8_t Data = USART_ReceiveData(USART1);
        uint16_t Next = (RxHead + 1) % RX_BUF_SIZE;

        if (Next != RxTail)          /* 没满 */
        {
            RxBuf[RxHead] = Data;
            RxHead = Next;
        }

        USART_ClearITPendingBit(USART1, USART_IT_RXNE);
    }
}

void Serial_Task(void)
{
    static uint8_t State = 0;
    static uint8_t pRx = 0;
    uint8_t Byte;

    while (RxTail != RxHead)
    {
        Byte = RxBuf[RxTail];
        RxTail = (RxTail + 1) % RX_BUF_SIZE;

        if (State == 0)
        {
            if (Byte == 0xFF) { State = 1; pRx = 0; }
        }
        else if (State == 1)
        {
            RxPacket[pRx++] = Byte;
            if (pRx >= 4) State = 2;
        }
        else
        {
            if (Byte == 0xFE) { RxFlag = 1; }
            State = 0;
        }
    }
}
```

主循环里每 1 ms 调一次 `Serial_Task()`，中断再长也不会丢字节（只要缓冲不溢出）。

## 0x30 发送端设计

发送就是把“数据 + 校验”按协议拼好，逐字节发：

```c
void Packet_Send(uint8_t *Data, uint8_t Len)
{
    uint8_t Check = 0;

    Serial_SendByte(0xFF);
    Serial_SendByte(Len);
    for (uint8_t i = 0; i < Len; i++)
    {
        Serial_SendByte(Data[i]);
        Check ^= Data[i];
    }
    Serial_SendByte(Check);
    Serial_SendByte(0xFE);
}
```

如果数据里可能出现 `0xFE`，就要转义：

```c
void Packet_SendEscaped(uint8_t Byte)
{
    if (Byte == 0xFE)      { Serial_SendByte(0xFD); Serial_SendByte(0x02); }
    else if (Byte == 0xFD) { Serial_SendByte(0xFD); Serial_SendByte(0x01); }
    else                   { Serial_SendByte(Byte); }
}
```

接收端做相反操作。转义会让代码复杂，但能彻底解决“数据里出现包头包尾”的问题。

## 0x40 代码实现

本篇代码文件：

| 文件 | 作用 |
| ---- | ---- |
| `Serial.h` / `Serial.c` | 初始化、发送、HEX 包状态机接收 |
| `main.c` | HEX 包收发实验 |
| `Text.c` | 文本命令解析（扩展） |
| `Packet.c` | 变长包 + 校验（扩展） |

### 0x41 固定 HEX 包：完整代码

`Serial.h`：

```c
#ifndef __SERIAL_H
#define __SERIAL_H

#include "stm32f10x.h"

void Serial_Init(void);
void Serial_SendByte(uint8_t Byte);
void Serial_SendArray(uint8_t *Array, uint16_t Length);
void Serial_SendString(char *String);

void Serial_SendPacket(void);
uint8_t Serial_GetRxFlag(void);
uint8_t *Serial_GetRxPacket(void);

#endif
```

`Serial.c`：

```c
#include "Serial.h"

static uint8_t Serial_TxPacket[4] = {0x01, 0x02, 0x03, 0x04};
static uint8_t Serial_RxPacket[4];
static volatile uint8_t Serial_RxFlag;

void Serial_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_9;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

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

void Serial_SendPacket(void)
{
    Serial_SendByte(0xFF);
    Serial_SendArray(Serial_TxPacket, 4);
    Serial_SendByte(0xFE);
}

uint8_t Serial_GetRxFlag(void)
{
    if (Serial_RxFlag == 1)
    {
        Serial_RxFlag = 0;
        return 1;
    }
    return 0;
}

uint8_t *Serial_GetRxPacket(void)
{
    return Serial_RxPacket;
}

void USART1_IRQHandler(void)
{
    static uint8_t RxState = 0;
    static uint8_t pRxPacket = 0;

    if (USART_GetITStatus(USART1, USART_IT_RXNE) == SET)
    {
        uint8_t RxData = USART_ReceiveData(USART1);

        if (RxState == 0)
        {
            if (RxData == 0xFF)
            {
                RxState = 1;
                pRxPacket = 0;
            }
        }
        else if (RxState == 1)
        {
            Serial_RxPacket[pRxPacket] = RxData;
            pRxPacket++;
            if (pRxPacket >= 4)
            {
                RxState = 2;
            }
        }
        else if (RxState == 2)
        {
            if (RxData == 0xFE)
            {
                Serial_RxFlag = 1;
                RxState = 0;
            }
            else
            {
                RxState = 0;   /* 包尾不对，丢弃整包 */
            }
        }

        USART_ClearITPendingBit(USART1, USART_IT_RXNE);
    }
}
```

`main.c`：

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "OLED.h"
#include "Key.h"
#include "Serial.h"

int main(void)
{
    uint8_t *RxPacket;

    OLED_Init();
    Key_Init();
    Serial_Init();

    OLED_ShowString(1, 1, "Tx:");
    OLED_ShowString(2, 1, "Rx:");

    while (1)
    {
        if (Key_GetNum() == 1)
        {
            Serial_SendPacket();
            OLED_ShowHexNum(1, 4, 0xFF, 2);
            OLED_ShowHexNum(1, 7, 0x01, 2);
            OLED_ShowHexNum(1, 10, 0x02, 2);
        }

        if (Serial_GetRxFlag() == 1)
        {
            RxPacket = Serial_GetRxPacket();
            OLED_ShowHexNum(2, 4, RxPacket[0], 2);
            OLED_ShowHexNum(2, 7, RxPacket[1], 2);
            OLED_ShowHexNum(2, 10, RxPacket[2], 2);
            OLED_ShowHexNum(2, 13, RxPacket[3], 2);
        }
    }
}
```

串口助手发 `FF 01 02 03 04 FE`，OLED 第二行显示 `01 02 03 04`。

### 0x42 文本包：命令解析

`Text.c`：

```c
#include "stm32f10x.h"
#include <string.h>
#include "Serial.h"
#include "LED.h"

char Text_RxPacket[100];
volatile uint8_t Text_RxFlag;

void Text_IRQHandler(uint8_t RxData)
{
    static uint8_t RxState = 0;
    static uint8_t pRxPacket = 0;

    if (RxState == 0)
    {
        if (RxData == '@' && Text_RxFlag == 0)
        {
            RxState = 1;
            pRxPacket = 0;
        }
    }
    else if (RxState == 1)
    {
        if (RxData == '\r')
        {
            RxState = 2;
        }
        else if (pRxPacket < 99)
        {
            Text_RxPacket[pRxPacket++] = RxData;
        }
    }
    else
    {
        if (RxData == '\n')
        {
            Text_RxPacket[pRxPacket] = '\0';
            Text_RxFlag = 1;
            RxState = 0;
        }
    }
}
```

主循环：

```c
if (Text_RxFlag == 1)
{
    if (strcmp(Text_RxPacket, "LED_ON") == 0)  LED_ON();
    if (strcmp(Text_RxPacket, "LED_OFF") == 0) LED_OFF();
    Text_RxFlag = 0;
}
```

串口助手发 `@LED_ON\r\n`，LED 点亮。注意串口助手要能发 `\r\n`（多数支持“发送新行”）。

### 0x43 变长包 + 校验（扩展）

`Packet.c`：

```c
#include "stm32f10x.h"
#include "Serial.h"

#define PACKET_MAX 32

uint8_t Packet_Buf[PACKET_MAX];
volatile uint8_t Packet_Len;
volatile uint8_t Packet_Ready;

void Packet_IRQHandler(uint8_t RxData)
{
    static uint8_t State = 0;
    static uint8_t Len = 0;
    static uint8_t Count = 0;
    static uint8_t Check = 0;

    if (State == 0)
    {
        if (RxData == 0xFF)
        {
            State = 1;
            Check = 0;
        }
    }
    else if (State == 1)
    {
        Len = RxData;

        if (Len == 0 || Len > PACKET_MAX)
        {
            State = 0;
        }
        else
        {
            Count = 0;
            State = 2;
        }
    }
    else if (State == 2)
    {
        Packet_Buf[Count++] = RxData;
        Check ^= RxData;

        if (Count >= Len)
        {
            State = 3;
        }
    }
    else if (State == 3)
    {
        if (RxData == Check)
        {
            Packet_Len = Len;
            Packet_Ready = 1;
        }
        State = 0;
    }
}
```

主循环校验并处理：

```c
if (Packet_Ready == 1)
{
    /* 这里 Packet_Buf[0..Packet_Len-1] 已经是校验通过的 */
    Packet_Ready = 0;
}
```

### 0x44 协议解析器（扩展）

把“收包”和“执行”彻底分开，主循环只处理完整包：

```c
void Packet_Process(void)
{
    if (Packet_Ready == 0) return;

    switch (Packet_Buf[0])
    {
        case 0x01:   /* 设置 LED */
            if (Packet_Buf[1] == 0x00) LED_OFF();
            else                       LED_ON();
            break;

        case 0x02:   /* 读版本 */
            {
                uint8_t Ver[2] = {1, 0};
                Packet_Send(Ver, 2);
            }
            break;

        default:
            break;
    }

    Packet_Ready = 0;
}
```

这样协议层只依赖 `Packet_Ready/Packet_Buf`，换传输介质（串口/蓝牙/以太网）时上层不用改。

### 0x45 协议版本与兼容

协议一旦发出去，就会有旧设备。最简单的兼容办法是**在包头后加版本号**：

```text
0xFF  VER  LEN  DATA...  CHECK  0xFE
```

- 新固件收到 `VER=1`，按旧格式解析；
- 收到 `VER=2`，按新格式解析；
- 收到不认识的版本，回 NACK 或直接丢弃。

另一种做法是“命令 ID + 长度”：新命令用新 ID，旧命令保持不动，接收端 `switch` 里加 `default: 忽略`。这样升级不会把老设备打挂。

### 0x47 调试：把包打印成十六进制

出问题时，第一件事是把收发双方的实际字节打印出来：

```c
void Packet_Dump(const char *Tag, uint8_t *Buf, uint16_t Len)
{
    printf("%s", Tag);
    for (uint16_t i = 0; i < Len; i++)
    {
        printf(" %02X", Buf[i]);
    }
    printf("\r\n");
}
```

```c
Packet_Dump("RX:", RxPacket, 4);
```

对比“发出去的”和“收进来的”，绝大多数问题（多一个字节、少一个字节、大小端反了）一眼就能看出来。

## 0x50 串口下载与调试

### 0x51 启动模式

| BOOT0 | BOOT1 | 启动区域 | 用途 |
| ----- | ----- | -------- | ---- |
| 0 | × | 主 Flash | 正常运行 |
| 1 | 0 | 系统存储器 | 出厂 BootLoader，串口 ISP |
| 1 | 1 | 内置 SRAM | 调试/特殊 |

F103C8T6 的 BOOT0 是独立引脚，BOOT1 与 PB2 复用；很多最小系统板用跳线帽选择。

### 0x52 FlyMcu 串口下载

1. USB-TTL 的 TX/RX 与单片机交叉、共地；
2. BOOT0 跳线拨到 1（BOOT1 保持 0），复位；
3. FlyMcu 选串口、波特率 115200，选生成的 `.hex`；
4. 勾选“编程后执行”，点“开始编程”；
5. 下载完成后把 BOOT0 拨回 0，再复位运行。

FlyMcu 的“DTR 低电平复位、RTS 高电平进 BootLoader”选项，是用串口的 DTR/RTS 自动控制复位和 BOOT0，省去手动拨跳线；不是所有 USB-TTL 都接了这两根线。

### 0x53 ST-LINK 与 SWD

ST-LINK 走 **SWD**：`SWDIO`（PA13）、`SWCLK`（PA14）、`GND`、`3.3V`。它比串口 ISP 强在：

- 可以在 Keil 里直接下载、单步调试、看变量；
- 不需要拨 BOOT0；
- 支持读保护、选项字节、批量擦除。

ST-LINK Utility 还能直接看 Flash 内容、修改选项字节。

### 0x54 选项字节与读保护

![选项字节与读保护](/images/posts/stm32-usart-packet/option-bytes.webp)

选项字节里有几类关键配置：

- **RDP 读保护**：置为“保护”后，SWD/调试器读不到 Flash；解除保护会**全片擦除**；
- **WRP 写保护**：把某些页设为只读，防止误写/误擦；
- **USER**：硬件看门狗、复位后是否进 Stop/Standby；
- **Data0/Data1**：两个用户自由字节。

串口 ISP 一般只能下载，不能在线调试；产品量产常用“串口 ISP + 读保护”，开发阶段用 SWD。

### 0x55 STM32 BootLoader 协议

F103 出厂 BootLoader 走 USART1（PA9/PA10），**8 位数据、偶校验、1 停止位（8E1）**，命令格式：

| 步骤 | 主机发 | 从机回 |
| ---- | ------ | ------ |
| 同步 | 0x7F | 0x79（ACK）或 0x1F（NACK） |
| 查命令 | 0x00 + 0xFF | 版本 + 命令表 |
| 擦除 | 0x21 + 校验 | ACK |
| 写 Flash | 0x31 + 地址 + 数据 | ACK |
| 跳转 | 0x43 + 地址 | ACK |

自己写 ISP 上位机时，注意：

- 波特率用 115200 或更低，8E1；
- 每包数据不超过 256 字节，地址按 4 字节对齐；
- 写之前先擦除对应页；
- 每步等 ACK，超时重发。

### 0x56 下载工具对比

| 工具 | 接口 | 速度 | 能否调试 | 适合 |
| ---- | ---- | ---- | -------- | ---- |
| FlyMcu | 串口 ISP | 慢（KB/s） | 否 | 应急、量产初检 |
| ST-LINK Utility | SWD | 快 | 有限 | 下载、读保护、批量擦除 |
| Keil + ST-LINK | SWD | 快 | 是 | 日常开发 |
| DFU | USB | 中 | 否 | 有 USB 的产品升级 |

量产时常用“ST-LINK 批量烧录 + 读保护”，售后升级用串口 ISP 或 USB DFU。

### 0x57 量产注意事项

- 烧录前先做**全片擦除**，避免旧选项字节残留；
- 打开 **RDP 读保护**，防止固件被读出；
- 记录芯片 **96 位 UID** 作为设备序列号；
- 烧录后做一次**自检**（LED、串口应答），确认不是“烧进去但没跑”；
- 保留一份“解除保护会全片擦除”的操作说明，避免误操作。

## 0x60 实验与调试

### 0x61 HEX 包实验

- 按键发送 `FF 01 02 03 04 FE`，串口助手应收到 6 字节；
- 串口助手发同样内容，OLED 显示 `01 02 03 04`；
- 故意把包尾改成 `FD`，接收端应丢弃、不更新显示。

### 0x62 文本命令实验

- 发 `@LED_ON\r\n`，LED 亮；发 `@LED_OFF\r\n`，灭；
- 发 `@ABC\r\n`，应无动作（或回 ERR，取决于实现）；
- 连发两条命令，检查状态机是否能正确切分。

### 0x63 逻辑分析仪

抓 TX 波形，按 8N1 解码，能看到 `FF 01 02 03 04 FE`。如果字节之间有明显空隙，是软件发送太慢；如果整包粘连，是发送端没等上一字节发完就写 DR。

### 0x64 压力测试

用串口助手循环发送 1000 包，统计丢包/错包：

- 丢包：中断被关太久、缓冲太小；
- 错包：校验失败、状态机被异常字节打断；
- 卡死：超时逻辑没做，状态机停在中间状态。

### 0x65 用 Python 写上位机

串口助手只能手动点，做批量测试/自动采集，用 Python + pyserial 更省事：

```python
import serial
import time

ser = serial.Serial("COM3", 9600, timeout=1)

def send_packet(data):
    frame = bytes([0xFF]) + bytes(data) + bytes([0xFE])
    ser.write(frame)

def recv_packet():
    buf = b""
    while True:
        b = ser.read(1)
        if not b:
            return None
        buf += b
        if len(buf) >= 6 and buf[0] == 0xFF and buf[-1] == 0xFE:
            return buf[1:-1]

send_packet([1, 2, 3, 4])
time.sleep(0.1)
print(recv_packet())
```

做自动测试时，把“发—收—比对”循环 1000 次，统计错误率，比人工点串口助手可靠得多。

## 0x70 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| 收不到完整包 | 波特率/校验不一致 | 两边 8N1、9600 |
| 数据错位 | 状态机没在异常时复位 | 包尾/长度错时回 S0 |
| 数据里出现 FE 就断包 | 数据未转义 | 加转义或改用长度+校验 |
| 粘包覆盖 | 一次收两包，标志被覆盖 | 加缓冲/队列 |
| 断包后永远收不到 | 没有超时复位 | 1ms 节拍 + 超时 |
| 校验总不对 | 校验范围不一致 | 约定只算载荷 |
| 文本命令不执行 | 行尾不是 `\r\n`、大小写不符 | 统一行尾、strcmp 精确匹配 |
| 中断里卡死 | 在中断里 printf/延时 | 中断只收，主循环处理 |
| FlyMcu 连不上 | BOOT0 没置 1、TX/RX 反、串口被占用 | 查跳线、线序、关闭串口助手 |
| 下载后不运行 | BOOT0 没拨回 0 | 拨回并复位 |
| 读保护后连不上 | RDP 生效 | 用 ISP 解除（会全片擦除） |
| 多包通信丢数据 | 没有流控/应答 | 加 ACK/重传/序号 |

## 0x80 小结

| 主题 | 关键点 |
| ---- | ------ |
| 固定 HEX 包 | 3 状态机，简单可靠 |
| 变长/文本包 | 长度字段或转义，注意边界 |
| 校验 | 异或/累加/CRC16，范围要约定 |
| 接收架构 | 中断收 + 主循环解析 + 超时复位 |
| 协议设计 | 边界、长度、校验、超时、应答 |
| 串口下载 | BOOT0=1 进系统存储器，FlyMcu 写 Flash |
| SWD | 可调试、可读保护，开发阶段首选 |

### 思考题

1. 固定长度包和变长包各适合什么场景？
2. 如果数据里一定出现 `0xFE`，有哪几种解决办法？
3. 状态机为什么要设“超时复位”？没有会怎样？
4. 校验只算载荷和算“长度+载荷”，对协议有什么影响？
5. 串口 ISP 为什么要先擦除再写？

串口协议没有标准答案，核心是**收发双方对“边界”和“校验”有一致的约定**。把状态机写对，剩下的就是加字段、加校验、加超时。
