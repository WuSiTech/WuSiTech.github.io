+++
title = "STM32 硬件 I2C：外设、事件、中断与 MPU6050 读写"
date = "2026-11-03T21:00:00+08:00"
lastmod = "2026-11-06T23:59:00+08:00"
draft = false
description = "把软件 I2C 的时序交给 STM32 的 I2C 外设：讲清 I2C1/I2C2 的框图、CCR/TRISE 计算、EV5/EV6/EV7/EV8 事件、AF/BERR/ARLO 错误、总线锁死恢复，给出轮询、中断、DMA 三种写法和 MPU6050 完整驱动。"
categories = [ "STM32" ]
tags = [ "STM32", "I2C", "MPU6050" ]
cover = "/images/pool/covers/covers-12.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 10 章后半（10-4、10-5）。

代码基于 **STM32F103C8T6 + STM32F10x 标准外设库 3.5.0**（API 已按 STM32F10x StdPeriph 3.5 头文件核对；Delay/OLED/Key 为课程配套驱动），不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 10-4 | I2C 外设简介、框图、基本结构、主机发送/接收流程、状态寄存器、事件 | 0x00 ~ 0x40 |
| 10-5 | 硬件 I2C 读写 MPU6050（代码、对比） | 0x50 ~ 0x70 |

视频之外还补了：CCR/TRISE 计算、中断与 DMA 方式、总线锁死恢复、软件/硬件实测对比、12 条故障排查。

## 0x00 为什么要硬件 I2C

软件 I2C 用 GPIO 翻转模拟时序，优点是简单、任意引脚可用；缺点是每个位都要 CPU 参与，占用时间、时序精度受中断影响，高速时容易出错。

STM32 内部集成了 **I2C 收发电路**：起始/停止条件、时钟、应答、数据移位都由硬件完成，CPU 只需要读写 `DR` 并等待事件标志。F103C8T6 有 **I2C1 和 I2C2**。

| 项目 | 软件 I2C | 硬件 I2C |
| ---- | -------- | -------- |
| 最高速率 | 几十 kHz | 100/400 kHz |
| CPU 占用 | 高 | 低 |
| 多主/仲裁 | 不支持 | 支持 |
| 时钟拉伸 | 难处理 | 硬件处理 |
| 代码复杂度 | 低 | 中（要懂事件） |

## 0x10 I2C 外设资源

| 外设 | 默认引脚 | 重映射 | 总线 |
| ---- | -------- | ------ | ---- |
| I2C1 | PB6(SCL) / PB7(SDA) | PB8/PB9 | APB1（36 MHz） |
| I2C2 | PB10(SCL) / PB11(SDA) | — | APB1（36 MHz） |

重映射要开 AFIO 时钟，并调 `GPIO_PinRemapConfig(GPIO_Remap_I2C1, ENABLE)`；重映射后原引脚不能再当 I2C 用。

## 0x20 I2C 外设框图

![STM32 I2C 功能框图](/images/posts/stm32-i2c-hw/i2c-periph.webp)

框图里几个关键部件：

- **数据寄存器 DR**：CPU 写入要发的字节，或读出刚收到的字节；
- **数据移位寄存器**：把字节按位串行移到 SDA，或从 SDA 移入；
- **比较器 + 自身地址寄存器（OAR1/OAR2）**：从机模式下判断“这个地址是不是叫我”；
- **时钟控制寄存器 CCR**：决定 SCL 频率和占空比；
- **控制寄存器 CR1/CR2**：使能、起始/停止、应答、中断、DMA；
- **状态寄存器 SR1/SR2**：SB、ADDR、TXE、RXNE、BTF、AF、BUSY 等事件；
- **错误校验 PEC**：SMBus 用的 CRC，普通 I2C 一般不用。

### 0x21 基本结构

数据流向：

```text
写：CPU → DR → 移位寄存器 → SDA
读：SDA → 移位寄存器 → DR → CPU
```

时钟由 CCR 分频 PCLK1 产生；起始/停止由 CR1 的 START/STOP 位控制；ACK 由 CR1 的 ACK 位控制。

### 0x22 寄存器

| 寄存器 | 作用 | 关键位 |
| ------ | ---- | ------ |
| `I2C_CR1` | 控制 1 | PE、START、STOP、ACK、POS、ITBUFEN、ITEVTEN、ITERREN |
| `I2C_CR2` | 控制 2 | FREQ[5:0]、ITERREN、ITBUFEN、DMAEN、LAST |
| `I2C_OAR1/2` | 自身地址 | 从机地址 |
| `I2C_DR` | 数据 | 收发共用 |
| `I2C_SR1` | 状态 1 | SB、ADDR、BTF、TXE、RXNE、AF、BERR、ARLO、OVR |
| `I2C_SR2` | 状态 2 | BUSY、MSL、TRA、DUALF、GENCALL |
| `I2C_CCR` | 时钟 | CCR[11:0]、DUTY、F/S |
| `I2C_TRISE` | 上升时间 | TRISE[5:0] |

### 0x23 从机模式

I2C 外设也能当从机：`I2C_OwnAddress1` 填本机地址，硬件自动比较、自动 ACK：

```c
void I2C_Slave_Init(uint8_t Address)
{
    I2C_InitTypeDef I2C_InitStructure;
    I2C_InitStructure.I2C_Mode = I2C_Mode_I2C;
    I2C_InitStructure.I2C_DutyCycle = I2C_DutyCycle_2;
    I2C_InitStructure.I2C_OwnAddress1 = Address << 1;   /* 7 位地址左移 */
    I2C_InitStructure.I2C_Ack = I2C_Ack_Enable;
    I2C_InitStructure.I2C_AcknowledgedAddress = I2C_AcknowledgedAddress_7bit;
    I2C_InitStructure.I2C_ClockSpeed = 100000;
    I2C_Init(I2C1, &I2C_InitStructure);

    I2C_ITConfig(I2C1, I2C_IT_EVT | I2C_IT_BUF, ENABLE);
    I2C_Cmd(I2C1, ENABLE);
}
```

从机事件：

- **ADDR**：主机叫到我了；
- **RXNE**：收到一个字节，读 DR；
- **TXE**：主机要读，写 DR；
- **STOPF**：主机发了停止。

从机模式还要注意“时钟拉伸”：CPU 没来得及写 DR 时，硬件会拉住 SCL，主机等着——这是 I2C 从机的天然流控。

### 0x24 SMBus 与 PEC

STM32 的 I2C 兼容 SMBus：支持 PEC（Packet Error Checking，CRC-8）、SMBus Alert、超时。普通 I2C 传感器不用；做电池管理（SBS）或服务器监控时会用到。

PEC 由硬件计算，读写时自动附加/校验，省去软件 CRC。

### 0x25 双地址与广播

- `I2C_OwnAddress2` 可以再设一个从机地址（7 位），适合“一个设备两个身份”；
- 广播地址 `0x00`（General Call）所有从机都收，可用于“全部复位/同步”；
- 双地址和广播默认关闭，需要 `I2C_DualAddressCmd` / `I2C_GeneralCallCmd` 打开。

### 0x26 电平转换与隔离

3.3 V 的 I2C 接 5 V 器件时，不能直接连（5 V 上拉会灌进 3.3 V 引脚）。常用两种：

- **双向电平转换芯片**（PCA9306、TXS0102）：一根线自动双向；
- **MOS 管 + 上拉**：低成本方案，栅极接 3.3 V，源/漏跨接两侧。

长线、强干扰场合可以加 I2C 隔离器（ADuM1250），把地环路断开。

### 0x27 I2C 与 SMBus 的区别

SMBus 基于 I2C，但加了：

- 超时（35 ms），防止从机拉死总线；
- PEC 校验；
- 固定的逻辑电平/电流；
- `SMBALERT` 中断线。

STM32 的 I2C 外设兼容 SMBus，但普通 I2C 传感器不需要开超时/PEC。混用两种设备时，注意 SMBus 的超时可能误判慢速 I2C 从机。

## 0x30 事件与状态机

硬件 I2C 的代码几乎都是“发起动作 → 等事件 → 下一步”。

| 事件 | 标志 | 含义 | 清除 |
| ---- | ---- | ---- | ---- |
| EV5 | SB=1 | 起始条件已发出 | 读 SR1 再写 DR |
| EV6 | ADDR=1 | 地址已发出且收到 ACK | 读 SR1 再读 SR2 |
| EV7 | RXNE=1 | 收到一个字节 | 读 DR |
| EV8 | TXE=1 | 数据寄存器空 | 写 DR |
| EV8_2 | TXE=1 且 BTF=1 | 最后一个字节发完 | 写 DR/STOP |
| AF | AF=1 | 从机回 NACK | 写 0 到 AF |
| BERR | BERR=1 | 起始/停止位置错误 | 写 0 |
| ARLO | ARLO=1 | 仲裁丢失 | 写 0 |
| BUSY | BUSY=1 | 总线忙 | 停止后自动清 |

### 0x31 主机发送流程

![主机发送器传送序列](/images/posts/stm32-i2c-hw/i2c-master.webp)

```text
START → EV5 → 地址+W → EV6 → 数据 → EV8 → ... → 最后字节 → EV8_2 → STOP
```

每一步都要等对应事件，不能“发完直接下一步”。

### 0x32 主机接收流程

```text
START → EV5 → 地址+R → EV6 → 读 DR → EV7 → ... → 最后字节前关 ACK、置 STOP → 读 DR
```

单字节接收的顺序很关键：**先 `ACK DISABLE` + `STOP`，再等 RXNE 读数据**。如果先读再关 ACK，硬件可能已经回了 ACK，从机会继续发下一个字节。

### 0x33 错误事件

- **AF（Acknowledge Failure）**：从机没应答，通常是地址错、从机没上电、上拉缺失；
- **BERR（Bus Error）**：起始/停止出现在错误位置，通常是干扰或时序问题；
- **ARLO（Arbitration Lost）**：多主竞争输了，硬件会自动切回从机模式；
- **OVR（Overrun）**：接收溢出，CPU 读得太慢。

错误发生时要清标志、发 STOP、必要时重新初始化。

### 0x34 轮询、中断与 DMA

| 方式 | CPU 占用 | 适合 |
| ---- | -------- | ---- |
| 轮询 | 高（死等事件） | 调试、低速少量数据 |
| 中断 | 中 | 事件驱动、非阻塞 |
| DMA | 低 | 大批量读写、MPU6050 FIFO |

## 0x40 初始化

### 0x41 时钟与 CCR/TRISE

I2C 的 SCL 由 PCLK1 分频：

```text
标准模式：CCR = PCLK1 / (2 × 100kHz)
快速模式：CCR = PCLK1 / (3 × 400kHz)   （DUTY=2）
TRISE = (PCLK1 × tr) + 1
```

36 MHz、100 kHz：`CCR = 180`，`TRISE = 36`（tr=1000ns）。
36 MHz、400 kHz：`CCR = 30`，`TRISE = 12`（tr=300ns）。

标准库的 `I2C_Init()` 会根据 `I2C_ClockSpeed` 自动算，不用手填。

### 0x42 初始化代码

```c
void MyI2C_HW_Init(void)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_I2C1, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);

    /* PB6 = SCL，PB7 = SDA，复用开漏 */
    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AF_OD;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_6 | GPIO_Pin_7;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOB, &GPIO_InitStructure);

    I2C_InitTypeDef I2C_InitStructure;
    I2C_InitStructure.I2C_Mode = I2C_Mode_I2C;
    I2C_InitStructure.I2C_DutyCycle = I2C_DutyCycle_2;
    I2C_InitStructure.I2C_OwnAddress1 = 0x00;
    I2C_InitStructure.I2C_Ack = I2C_Ack_Enable;
    I2C_InitStructure.I2C_AcknowledgedAddress = I2C_AcknowledgedAddress_7bit;
    I2C_InitStructure.I2C_ClockSpeed = 100000;
    I2C_Init(I2C1, &I2C_InitStructure);

    I2C_Cmd(I2C1, ENABLE);
}
```

> 引脚必须是 **复用开漏**（`GPIO_Mode_AF_OD`）。配成复用推挽，I2C 的“线与”就没了，多设备时会冲突。

### 0x43 重映射

```c
RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);
GPIO_PinRemapConfig(GPIO_Remap_I2C1, ENABLE);
```

重映射后 I2C1 在 PB8/PB9，PB6/PB7 释放为普通 GPIO。

### 0x44 时钟拉伸与超时

硬件 I2C 会自动处理从机的时钟拉伸（从机拉住 SCL，硬件等待），但**等多久没有上限**。从机异常时，`while (I2C_CheckEvent(...))` 会死循环。

工程写法：

```c
uint32_t Timeout = 100000;

while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_MODE_SELECT) != SUCCESS)
{
    if (--Timeout == 0)
    {
        I2C_GenerateSTOP(I2C1, ENABLE);
        I2C_BusRecovery();
        return;
    }
}
```

超时后不要只 `return`，要发 STOP + 恢复总线，否则下一次通信还是卡。

### 0x45 中断优先级与实时性

I2C 中断（EV/ER）不要设得太高，也不要太长：

- 事件中断里只做“读 SR、写 DR、置状态”，耗时操作放主循环；
- 错误中断里清标志、记录错误码，必要时复位 I2C；
- 如果系统里有更实时的中断（电机 PWM、编码器），I2C 优先级要低于它们。

## 0x50 代码实现

本篇代码文件：

| 文件 | 作用 |
| ---- | ---- |
| `MyI2C_HW.h` / `MyI2C_HW.c` | 硬件 I2C 轮询收发 |
| `MPU6050.h` / `MPU6050.c` | MPU6050 驱动 |
| `main.c` | 读 WHO_AM_I、三轴数据 |

### 0x51 写寄存器

```c
#define MPU6050_ADDR 0xD0   /* 8 位写地址：0x68 << 1 */

void MPU6050_WriteReg(uint8_t RegAddress, uint8_t Data)
{
    /* 1. 起始 */
    I2C_GenerateSTART(I2C1, ENABLE);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_MODE_SELECT) != SUCCESS);

    /* 2. 地址 + 写 */
    I2C_Send7bitAddress(I2C1, MPU6050_ADDR, I2C_Direction_Transmitter);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_TRANSMITTER_MODE_SELECTED) != SUCCESS);

    /* 3. 寄存器地址 */
    I2C_SendData(I2C1, RegAddress);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_BYTE_TRANSMITTING) != SUCCESS);

    /* 4. 数据 */
    I2C_SendData(I2C1, Data);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_BYTE_TRANSMITTED) != SUCCESS);

    /* 5. 停止 */
    I2C_GenerateSTOP(I2C1, ENABLE);
}
```

标准库的 `I2C_Send7bitAddress()` 传的是**已经左移好的 8 位地址**（0x68 << 1 = 0xD0），函数内部只负责置/清最低位（R/W），不会再左移。传 0x68 会被当成地址 0x34，从机不应答，卡在 EV6。从机模式下的 `I2C_OwnAddress1` 同理，也要传左移后的 8 位地址（代码里用 `Address << 1`）。

### 0x52 读寄存器

```c
uint8_t MPU6050_ReadReg(uint8_t RegAddress)
{
    uint8_t Data;

    /* 1. 起始 + 写地址 */
    I2C_GenerateSTART(I2C1, ENABLE);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_MODE_SELECT) != SUCCESS);

    I2C_Send7bitAddress(I2C1, MPU6050_ADDR, I2C_Direction_Transmitter);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_TRANSMITTER_MODE_SELECTED) != SUCCESS);

    /* 2. 寄存器地址 */
    I2C_SendData(I2C1, RegAddress);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_BYTE_TRANSMITTED) != SUCCESS);

    /* 3. 重复起始 + 读地址 */
    I2C_GenerateSTART(I2C1, ENABLE);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_MODE_SELECT) != SUCCESS);

    I2C_Send7bitAddress(I2C1, MPU6050_ADDR, I2C_Direction_Receiver);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_RECEIVER_MODE_SELECTED) != SUCCESS);

    /* 4. 只读 1 字节：先关 ACK、预约 STOP，再读 DR */
    I2C_AcknowledgeConfig(I2C1, DISABLE);
    I2C_GenerateSTOP(I2C1, ENABLE);

    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_BYTE_RECEIVED) != SUCCESS);
    Data = I2C_ReceiveData(I2C1);

    I2C_AcknowledgeConfig(I2C1, ENABLE);

    return Data;
}
```

顺序很关键：**先 `ACK DISABLE` + `STOP`，再等 RXNE 读数据**。

### 0x53 连续读

```c
void MPU6050_ReadRegs(uint8_t RegAddress, uint8_t *Buf, uint8_t Len)
{
    I2C_GenerateSTART(I2C1, ENABLE);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_MODE_SELECT) != SUCCESS);

    I2C_Send7bitAddress(I2C1, MPU6050_ADDR, I2C_Direction_Transmitter);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_TRANSMITTER_MODE_SELECTED) != SUCCESS);

    I2C_SendData(I2C1, RegAddress);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_BYTE_TRANSMITTED) != SUCCESS);

    I2C_GenerateSTART(I2C1, ENABLE);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_MODE_SELECT) != SUCCESS);

    I2C_Send7bitAddress(I2C1, MPU6050_ADDR, I2C_Direction_Receiver);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_RECEIVER_MODE_SELECTED) != SUCCESS);

    while (Len)
    {
        if (Len == 1)
        {
            I2C_AcknowledgeConfig(I2C1, DISABLE);
            I2C_GenerateSTOP(I2C1, ENABLE);
        }

        while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_BYTE_RECEIVED) != SUCCESS);
        *Buf++ = I2C_ReceiveData(I2C1);
        Len--;

        if (Len == 0) break;
    }

    I2C_AcknowledgeConfig(I2C1, ENABLE);
}
```

### 0x54 中断方式

轮询会死等，中断方式可以把等待交给硬件：

```c
void MyI2C_HW_IT_Init(void)
{
    NVIC_InitTypeDef NVIC_InitStructure;

    NVIC_InitStructure.NVIC_IRQChannel = I2C1_EV_IRQn;
    NVIC_InitStructure.NVIC_IRQChannelCmd = ENABLE;
    NVIC_InitStructure.NVIC_IRQChannelPreemptionPriority = 1;
    NVIC_InitStructure.NVIC_IRQChannelSubPriority = 1;
    NVIC_Init(&NVIC_InitStructure);

    I2C_ITConfig(I2C1, I2C_IT_EVT | I2C_IT_BUF | I2C_IT_ERR, ENABLE);
}

void I2C1_EV_IRQHandler(void)
{
    /* 按 SR1/SR2 判断 EV5/EV6/EV7/EV8，推进状态机 */
}

void I2C1_ER_IRQHandler(void)
{
    if (I2C_GetITStatus(I2C1, I2C_IT_AF))
    {
        I2C_ClearITPendingBit(I2C1, I2C_IT_AF);
        /* 记录错误、复位状态机 */
    }
}
```

中断方式需要自己维护“发送到第几个字节”的状态机，比轮询复杂，但不会阻塞主循环。

### 0x55 DMA 方式

大批量数据（MPU6050 FIFO、EEPROM 整页）用 DMA：

```c
void MyI2C_HW_DMA_Init(void)
{
    RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1, ENABLE);

    DMA_InitTypeDef DMA_InitStructure;
    DMA_InitStructure.DMA_PeripheralBaseAddr = (uint32_t)&I2C1->DR;
    DMA_InitStructure.DMA_DIR = DMA_DIR_PeripheralDST;   /* 发送 */
    DMA_InitStructure.DMA_PeripheralInc = DMA_PeripheralInc_Disable;
    DMA_InitStructure.DMA_MemoryInc = DMA_MemoryInc_Enable;
    DMA_InitStructure.DMA_PeripheralDataSize = DMA_PeripheralDataSize_Byte;
    DMA_InitStructure.DMA_MemoryDataSize = DMA_MemoryDataSize_Byte;
    DMA_InitStructure.DMA_Mode = DMA_Mode_Normal;
    DMA_InitStructure.DMA_Priority = DMA_Priority_Medium;
    DMA_InitStructure.DMA_M2M = DMA_M2M_Disable;
    DMA_Init(DMA1_Channel6, &DMA_InitStructure);   /* I2C1_TX = Ch6 */

    I2C_DMACmd(I2C1, ENABLE);
}
```

I2C1_TX 固定用 **DMA1_Channel6**，I2C1_RX 用 **DMA1_Channel7**；I2C2 的映射不同，查手册。

### 0x56 DMA 读 FIFO

MPU6050 的 FIFO 一次可能有几百字节，用 DMA 读最省 CPU：

```c
uint8_t RxBuf[32];   /* FIFO 数据缓冲区 */

void I2C_DMA_Rx_Init(void)
{
    RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1, ENABLE);

    DMA_InitTypeDef DMA_InitStructure;
    DMA_InitStructure.DMA_PeripheralBaseAddr = (uint32_t)&I2C1->DR;
    DMA_InitStructure.DMA_MemoryBaseAddr = (uint32_t)RxBuf;
    DMA_InitStructure.DMA_DIR = DMA_DIR_PeripheralSRC;
    DMA_InitStructure.DMA_BufferSize = sizeof(RxBuf);
    DMA_InitStructure.DMA_PeripheralInc = DMA_PeripheralInc_Disable;
    DMA_InitStructure.DMA_MemoryInc = DMA_MemoryInc_Enable;
    DMA_InitStructure.DMA_PeripheralDataSize = DMA_PeripheralDataSize_Byte;
    DMA_InitStructure.DMA_MemoryDataSize = DMA_MemoryDataSize_Byte;
    DMA_InitStructure.DMA_Mode = DMA_Mode_Normal;
    DMA_InitStructure.DMA_Priority = DMA_Priority_Medium;
    DMA_InitStructure.DMA_M2M = DMA_M2M_Disable;
    DMA_Init(DMA1_Channel7, &DMA_InitStructure);   /* I2C1_RX = Ch7 */

    I2C_DMACmd(I2C1, ENABLE);
}
```

读数据流程：

1. START + 地址+W + 寄存器地址；
2. 重复起始 + 地址+R；
3. `DMA_Cmd(ENABLE)`，硬件在每个 RXNE 时搬走；
4. 最后一个字节前 `I2C_DMALastTransferCmd(I2C1, ENABLE)`，让硬件发 NACK + STOP；
5. 等 DMA TC。

DMA 接收一定要设“最后传输”标志，否则硬件会一直 ACK，从机继续发。

### 0x57 I2C 的 DMA 通道

| 外设 | 方向 | 通道 |
| ---- | ---- | ---- |
| I2C1_TX | M2P | DMA1_Channel6 |
| I2C1_RX | P2M | DMA1_Channel7 |
| I2C2_TX | M2P | DMA1_Channel4 |
| I2C2_RX | P2M | DMA1_Channel5 |

通道是固定的，选错就等不到请求。

## 0x60 MPU6050 硬件 I2C 驱动

`MPU6050.h`：

```c
#ifndef __MPU6050_H
#define __MPU6050_H

#include "stm32f10x.h"

void MPU6050_Init(void);
uint8_t MPU6050_WhoAmI(void);
void MPU6050_GetData(int16_t *AccX, int16_t *AccY, int16_t *AccZ,
                     int16_t *GyroX, int16_t *GyroY, int16_t *GyroZ);

#endif
```

`MPU6050.c`：

```c
#include "MPU6050.h"
#include "MyI2C_HW.h"

void MPU6050_Init(void)
{
    MyI2C_HW_Init();

    MPU6050_WriteReg(0x6B, 0x01);
    MPU6050_WriteReg(0x19, 0x09);
    MPU6050_WriteReg(0x1A, 0x06);
    MPU6050_WriteReg(0x1B, 0x18);
    MPU6050_WriteReg(0x1C, 0x18);
}

uint8_t MPU6050_WhoAmI(void)
{
    return MPU6050_ReadReg(0x75);
}

void MPU6050_GetData(int16_t *AccX, int16_t *AccY, int16_t *AccZ,
                     int16_t *GyroX, int16_t *GyroY, int16_t *GyroZ)
{
    uint8_t Data[14];

    MPU6050_ReadRegs(0x3B, Data, 14);

    *AccX  = (Data[0]  << 8) | Data[1];
    *AccY  = (Data[2]  << 8) | Data[3];
    *AccZ  = (Data[4]  << 8) | Data[5];
    *GyroX = (Data[8]  << 8) | Data[9];
    *GyroY = (Data[10] << 8) | Data[11];
    *GyroZ = (Data[12] << 8) | Data[13];
}
```

`main.c`：

```c
int main(void)
{
    int16_t ax, ay, az, gx, gy, gz;

    Serial_Init();
    MPU6050_Init();

    printf("WHO_AM_I=0x%02X\r\n", MPU6050_WhoAmI());

    while (1)
    {
        MPU6050_GetData(&ax, &ay, &az, &gx, &gy, &gz);
        printf("%d,%d,%d,%d,%d,%d\r\n", ax, ay, az, gx, gy, gz);
        Delay_ms(100);
    }
}
```

## 0x70 实验与调试

### 0x71 先读 WHO_AM_I

`WHO_AM_I` 应为 0x68。读不到：

- 查 PB6/PB7 是否被别的外设占用；
- 查上拉、供电、AD0；
- 查是否卡在 EV5（I2C 没使能/引脚错）。

### 0x72 卡在 EV5/EV6

| 卡住位置 | 常见原因 |
| -------- | -------- |
| EV5 | I2C 没使能、GPIO 不是 AF_OD、总线被拉低 |
| EV6 | 地址错、从机没上电、AF 置位 |
| EV8 | 从机拉低 SCL（时钟拉伸）、上次 STOP 没完成 |
| EV7 | 没读 DR、ACK 配置错 |

调试时可以在每个 `while` 里加超时计数，把“卡死”变成“报错”。

### 0x73 总线锁死恢复

从机异常时可能一直拉低 SDA，I2C 外设会一直 BUSY。恢复办法：

1. 关 I2C，把 SCL/SDA 配成普通 GPIO 开漏；
2. 手动发 9 个 SCL 脉冲（SDA 释放），让从机把剩余位移完；
3. 发一个 STOP（SCL 高时 SDA 由低变高）；
4. 重新初始化 I2C。

```c
void I2C_BusRecovery(void)
{
    GPIO_InitTypeDef GPIO_InitStructure;
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);

    I2C_Cmd(I2C1, DISABLE);

    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_6 | GPIO_Pin_7;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOB, &GPIO_InitStructure);

    GPIO_SetBits(GPIOB, GPIO_Pin_7);

    for (uint8_t i = 0; i < 9; i++)
    {
        GPIO_ResetBits(GPIOB, GPIO_Pin_6);
        Delay_us(5);
        GPIO_SetBits(GPIOB, GPIO_Pin_6);
        Delay_us(5);
    }

    /* STOP：SCL 高时 SDA 由低变高 */
    GPIO_ResetBits(GPIOB, GPIO_Pin_7);
    Delay_us(5);
    GPIO_SetBits(GPIOB, GPIO_Pin_6);
    Delay_us(5);
    GPIO_SetBits(GPIOB, GPIO_Pin_7);
    Delay_us(5);

    MyI2C_HW_Init();   /* 重新初始化 */
}
```

### 0x74 软件与硬件实测对比

同一颗 MPU6050、同一 14 字节数据：

| 项目 | 软件 I2C（10 µs 延时） | 硬件 I2C 100 kHz |
| ---- | ---------------------- | ---------------- |
| 单次读 14 字节耗时 | 约 4 ~ 5 ms | 约 1.5 ms |
| CPU 占用 | 100% | 等待时可做别的事 |
| 波形 | GPIO 翻转 | 硬件驱动 |
| 稳定性 | 受中断影响 | 好 |

### 0x75 用硬件 I2C 读写 EEPROM

AT24C02 的时序和 MPU6050 一样，但写之后要等 5 ms：

```c
void AT24C02_WriteByte(uint8_t Reg, uint8_t Data)
{
    I2C_GenerateSTART(I2C1, ENABLE);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_MODE_SELECT) != SUCCESS);

    I2C_Send7bitAddress(I2C1, 0xA0, I2C_Direction_Transmitter);   /* 0x50 << 1 */
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_TRANSMITTER_MODE_SELECTED) != SUCCESS);

    I2C_SendData(I2C1, Reg);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_BYTE_TRANSMITTING) != SUCCESS);

    I2C_SendData(I2C1, Data);
    while (I2C_CheckEvent(I2C1, I2C_EVENT_MASTER_BYTE_TRANSMITTED) != SUCCESS);

    I2C_GenerateSTOP(I2C1, ENABLE);
    Delay_ms(5);
}
```

连续写一页（8 字节）时，地址会自动递增，但**不能跨页**；跨页要分两次写。

### 0x76 示波器与逻辑分析仪

- 量 SCL 高/低电平：应接近 0 和 3.3 V；
- 量一位宽度：100 kHz 时约 10 µs，400 kHz 时约 2.5 µs；
- 看上升沿：如果圆角明显，说明上拉太大/电容太大；
- 逻辑分析仪解码：应看到 `S | 地址+W | ACK | 寄存器 | ACK | Sr | 地址+R | ACK | 数据 | NACK | P`。

解码报 NACK，先怀疑地址/供电；解码报 BERR，先怀疑起始/停止位置和干扰。

### 0x77 时序参数速查

| 参数 | 100 kHz | 400 kHz |
| ---- | ------- | ------- |
| SCL 频率 | 100 kHz | 400 kHz |
| tLOW | ≥4.7 µs | ≥1.3 µs |
| tHIGH | ≥4.0 µs | ≥0.6 µs |
| 上升时间 tr | ≤1000 ns | ≤300 ns |
| 下降时间 tf | ≤300 ns | ≤300 ns |
| 总线电容 | ≤400 pF | ≤400 pF |

硬件 I2C 由 CCR/TRISE 决定，软件 I2C 由 `Delay_us` 决定。无论哪种，都要留余量：实际速率比标称低 10% 比“卡在临界”稳。

### 0x78 多设备与地址冲突

同一总线挂多个 MPU6050 时，靠 AD0 只能分两个地址。更多设备要：

- 用 I2C 多路开关（TCA9548A），一路变八路；
- 分时供电，一次只上一个；
- 换带地址选择的传感器。

地址冲突的典型现象：两个设备同时 ACK，数据被“线与”成乱码；读 WHO_AM_I 可能得到两个值的按位与。

### 0x79 上电自检清单

产品上电时按顺序检查，能快速定位问题：

1. 读 `WHO_AM_I`，不等于 0x68 就报错；
2. 检查 `I2C1->SR2` 的 BUSY，若一直为 1，做总线恢复；
3. 读一次 `PWR_MGMT_1`，确认不是 0x40（sleep）；
4. 连续读 14 字节，确认数据不是全 0/全 FF；
5. 静止时陀螺读数应在零偏附近（几十 LSB）；
6. 记录错误计数（AF/BERR/ARLO），超过阈值就复位 I2C。

把这套自检做成 `MPU6050_SelfTest()`，量产测试和现场排障都能用。

## 0x80 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| 卡在 EV5 | I2C 没使能、引脚不是 AF_OD、总线被拉低 | 查 `I2C_Cmd`、GPIO 模式、上拉 |
| 卡在 EV6 | 地址错、从机没电、AF | 查地址/供电，读 SR1 |
| 读数据全 0/FF | 还在 sleep、地址错 | 写 0x6B、读 WHO_AM_I |
| 最后一个字节丢 | 没等 EV8_2 就 STOP | 等 BTF |
| 多字节读只到第一个 | 最后字节没关 ACK | 关 ACK + STOP 再读 |
| BUSY 一直为 1 | 从机拉死总线 | 9 个时钟 + STOP 恢复 |
| AF 置位 | 从机 NACK | 查地址、从机状态 |
| BERR | 起始/停止位置错、干扰 | 查波形、降速 |
| 400 kHz 不稳 | 上拉/电容/线长 | 降 100 kHz、减小上拉 |
| 重映射后无反应 | 没开 AFIO/没调 Remap | 开 AFIO、`GPIO_PinRemapConfig` |
| 中断进不去 | 没配 NVIC/ITEVTEN | 配 NVIC、`I2C_ITConfig` |
| DMA 不搬 | 通道错、DMAEN 没开 | I2C1_TX=Ch6、`I2C_DMACmd` |

## 0x90 小结

| 阶段 | 主机发送 | 主机接收 |
| ---- | -------- | -------- |
| 起始 | START，等 EV5 | START，等 EV5 |
| 地址 | 地址+W，等 EV6 | 地址+W，等 EV6 |
| 数据 | 写 DR，等 EV8/EV8_2 | 重复起始 + 地址+R，等 EV6 |
| 结束 | STOP | 关 ACK + STOP，读 DR |

### 思考题

1. 为什么 I2C 引脚必须配成复用开漏？
2. EV8 和 EV8_2 的区别是什么？最后一个字节该等哪个？
3. 单字节读为什么要“先关 ACK、置 STOP，再读 DR”？
4. 总线 BUSY 一直为 1，除了复位还有哪些恢复办法？
5. 硬件 I2C 的 DMA 发送，为什么还要等 BTF 才能发 STOP？

硬件 I2C 把“翻转引脚”换成了“等事件”，本质流程和软件 I2C 完全一样。把 EV5/EV6/EV7/EV8 对应到时序图上，代码就不再是“抄寄存器”了。
