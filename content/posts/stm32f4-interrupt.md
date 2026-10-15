+++
title = "STM32F4 配置中断"
date = "2026-10-14T22:30:00+08:00"
draft = false
description = "以 STM32F411CEU6 与标准外设库为例，完整实现「PA0 下降沿触发 EXTI0 中断、翻转 PC13 电平」的中断链路：时钟使能、GPIO 配置、SYSCFG 线映射、EXTI 触发条件、NVIC 优先级分组与中断服务程序，并给出寄存器级实现与排查思路。"
categories = [ "STM32" ]
tags = [ "STM32F4", "中断" ]
cover = "images/stm32/interrupt-path.webp"
banner = "images/banner.webp"
+++

以 **STM32F411CEU6** 与 **标准外设库（Standard Peripheral Library，以下简称 SPL）** 为例，完整实现「PA0 下降沿触发 → EXTI0 中断 → 翻转 PC13 电平」这一中断链路。文中代码取自实际工程 `STM32_SPL`（Keil 工程，启动文件 `startup_stm32f411xe.s`），可直接编译运行。

![STM32F4 外部中断通路：引脚 → SYSCFG → EXTI → NVIC → ISR](/images/stm32/interrupt-path.webp)

*图 1：外部中断的信号通路，以及各环节对应的寄存器。*

该链路是单向的：**引脚 → SYSCFG 选线 → EXTI 边沿触发 → NVIC 仲裁与使能 → ISR 执行**。所谓配置中断，本质上是依次打通上述五个环节。

## 一、中断配置涉及的六个环节

| # | 环节 | 关键技术点 | 相关函数 |
| - | ---- | ---------- | -------- |
| 1 | 时钟使能 | GPIO 挂载于 AHB1，SYSCFG 挂载于 APB2 | `RCC_AHB1PeriphClockCmd`、`RCC_APB2PeriphClockCmd` |
| 2 | GPIO 配置 | 中断引脚须配置为输入，上下拉决定空闲电平 | `GPIO_Init` |
| 3 | 线映射 | EXTI 仅有 16 条信号线，由 SYSCFG 指定其归属端口 | `SYSCFG_EXTILineConfig` |
| 4 | EXTI 配置 | 选择信号线、触发边沿与中断模式 | `EXTI_Init` |
| 5 | NVIC 配置 | 优先级分组、抢占/子优先级、通道使能 | `NVIC_PriorityGroupConfig`、`NVIC_Init` |
| 6 | 中断服务程序 | 函数名须与启动文件向量表一致，并清除挂起标志 | `EXTI0_IRQHandler`、`EXTI_ClearITPendingBit` |

任一环节缺失，结果只能是两种：**中断始终不触发**，或**触发后无法正常返回**。

## 二、完整代码

```c
#include "main.h"

/* 系统节拍递减计数，由 stm32f4xx_it.c 中的 SysTick_Handler 调用 */
static __IO uint32_t TimingDelay;
void TimingDelay_Decrement(void) { if (TimingDelay != 0x00) TimingDelay--; }

/* 6. 中断服务程序：函数名须与 startup_stm32f411xe.s 中的向量名完全一致 */
void EXTI0_IRQHandler(void)
{
    if (EXTI_GetITStatus(EXTI_Line0) != RESET)   /* 先确认挂起源确实为 EXTI0 */
    {
        GPIO_ToggleBits(GPIOC, GPIO_Pin_13);     /* 执行处理：翻转 PC13 电平 */
        EXTI_ClearITPendingBit(EXTI_Line0);      /* 清除挂起标志，否则退出后立即重入 */
    }
}

int main(void)
{
    /* 1. 时钟使能：GPIOA/GPIOC 挂载于 AHB1；SYSCFG 挂载于 APB2，未使能则无法配置线映射 */
    RCC_AHB1PeriphClockCmd(RCC_AHB1Periph_GPIOA, ENABLE);
    RCC_AHB1PeriphClockCmd(RCC_AHB1Periph_GPIOC, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_SYSCFG, ENABLE);

    GPIO_InitTypeDef GPIO_Struct;

    /* 2. PA0：上拉输入，空闲为高电平，按下接地 → 产生下降沿 */
    GPIO_Struct.GPIO_Mode  = GPIO_Mode_IN;
    GPIO_Struct.GPIO_OType = GPIO_OType_PP;
    GPIO_Struct.GPIO_Pin   = GPIO_Pin_0;
    GPIO_Struct.GPIO_PuPd  = GPIO_PuPd_UP;
    GPIO_Struct.GPIO_Speed = GPIO_High_Speed;
    GPIO_Init(GPIOA, &GPIO_Struct);

    /* PC13：推挽输出，驱动板载 LED（多数最小系统板为低电平点亮） */
    GPIO_Struct.GPIO_Mode  = GPIO_Mode_OUT;
    GPIO_Struct.GPIO_Pin   = GPIO_Pin_13;
    GPIO_Struct.GPIO_Speed = GPIO_Low_Speed;   /* PC13 属备份域，输出速度不宜设置过高 */
    GPIO_Init(GPIOC, &GPIO_Struct);

    /* 3. 将 EXTI0 映射至 PA0（EXTI 线号 = 引脚号） */
    SYSCFG_EXTILineConfig(EXTI_PortSourceGPIOA, EXTI_PinSource0);

    /* 4. EXTI0：中断模式 + 下降沿触发 + 使能 */
    EXTI_InitTypeDef EXTI_Struct;
    EXTI_Struct.EXTI_Line    = EXTI_Line0;
    EXTI_Struct.EXTI_Mode    = EXTI_Mode_Interrupt;   /* 中断模式，而非事件模式 */
    EXTI_Struct.EXTI_Trigger = EXTI_Trigger_Falling;  /* 上拉 + 下降沿 = 按下时触发 */
    EXTI_Struct.EXTI_LineCmd = ENABLE;
    EXTI_Init(&EXTI_Struct);

    /* 5. NVIC：分组 2 → 抢占 2 位、子优先级 2 位；抢占 = 2，子优先级 = 2 */
    NVIC_InitTypeDef NVIC_Struct;
    NVIC_PriorityGroupConfig(NVIC_PriorityGroup_2);
    NVIC_Struct.NVIC_IRQChannel                   = EXTI0_IRQn;
    NVIC_Struct.NVIC_IRQChannelPreemptionPriority = 2;
    NVIC_Struct.NVIC_IRQChannelSubPriority        = 2;
    NVIC_Struct.NVIC_IRQChannelCmd                = ENABLE;
    NVIC_Init(&NVIC_Struct);

    while (1) { }
}
```

## 三、逐段解析

中断的触发条件由硬件连接决定，因此先明确本工程的接线：

![硬件接线：KEY 接在 PA0 与 GND 之间，PA0 设为上拉输入，LED 接在 PC13](/images/stm32/hardware-wiring.webp)

*图 2：KEY 一端接 PA0、一端接 GND，因此 PA0 平时被上拉为高电平，按下时接地——这正是「上拉 + 下降沿触发」的由来。PC13 上挂载的是 LED（多数 F411 最小系统板为低电平点亮）。*

### 1. 时钟使能：最易遗漏的一步

- `GPIOA`、`GPIOC` 挂载于 **AHB1** 总线，使用 `RCC_AHB1PeriphClockCmd` 使能。
- `SYSCFG` 挂载于 **APB2** 总线，使用 `RCC_APB2PeriphClockCmd` 使能。

SYSCFG 时钟是 F4 系列特有的易错点：**若未使能 SYSCFG 时钟，`SYSCFG_EXTILineConfig()` 对寄存器的写入不生效**，此后 EXTI 即使配置正确也无法产生中断。（F1 系列无 SYSCFG，对应功能由 AFIO 承担，思路一致。）

### 2. GPIO 配置：中断引脚仅需输入模式

EXTI 不需要将引脚配置为复用功能，`GPIO_Mode_IN` 即可。上下拉的取值与触发边沿必须匹配：

- `GPIO_PuPd_UP` + `EXTI_Trigger_Falling`：空闲为高，按下接地 → **下降沿**，最常用的按键接法；
- `GPIO_PuPd_DOWN` + `EXTI_Trigger_Rising`：空闲为低，按下接高 → 上升沿；
- 浮空输入（`GPIO_PuPd_NOPULL`）用于按键时极易误触发，应避免使用。

PC13 上的 LED：多数 F411 最小系统板（如 WeAct Blackpill）将 LED 接于 PC13，且**低电平点亮**，因此调用 `GPIO_ToggleBits` 即可观察到亮灭交替。

> PC13/PC14/PC15 由备份域供电，数据手册限定其作为输出时**最高 2 MHz、负载 30 pF、驱动电流 3 mA**，故此处采用 `GPIO_Low_Speed` 比 `GPIO_High_Speed` 更为合规。

### 3. SYSCFG：16 条 EXTI 线的端口归属

EXTI 仅有 **EXTI0 ~ EXTI15** 共 16 条信号线，而每个端口均有 16 个引脚，因此约定：**引脚号即 EXTI 线号**，同号线在不同端口之间由 SYSCFG 二选一。

```c
SYSCFG_EXTILineConfig(EXTI_PortSourceGPIOA, EXTI_PinSource0);  /* EXTI0 ← PA0 */
```

该语句实质是将 `SYSCFG->EXTICR1` 中 EXTI0 对应的字段写为 `0b0000`（端口 A）。需注意：**同一时刻 EXTI0 只能归属一个端口**，选定 PA0 后便不能再由 PB0 触发该线。

### 4. EXTI 配置：四个字段各有作用

| 字段 | 本例取值 | 说明 |
| ---- | -------- | ---- |
| `EXTI_Line` | `EXTI_Line0` | 选择信号线 EXTI0 |
| `EXTI_Mode` | `EXTI_Mode_Interrupt` | 产生中断请求并进入 ISR；`Event` 仅产生事件，不进入 ISR |
| `EXTI_Trigger` | `EXTI_Trigger_Falling` | 下降沿触发；双边沿用 `EXTI_Trigger_Rising_Falling` |
| `EXTI_LineCmd` | `ENABLE` | 使能该线的中断屏蔽位（`EXTI->IMR`） |

### 5. NVIC：优先级分组与两种优先级

Cortex-M4 的 NVIC 在 STM32F4 上实现了 **4 个优先级位，对应 16 个优先级**，且**数值越小优先级越高**（0 为最高）。这 4 位由「分组」划分为抢占优先级与子优先级：

| 分组 | 抢占位数 | 子优先级位数 | 抢占取值范围 | 子优先级取值范围 | 是否支持嵌套 |
| ---- | -------- | ------------ | ------------ | ---------------- | ------------ |
| `NVIC_PriorityGroup_0` | 0 | 4 | 0 | 0 ~ 15 | 外部中断之间不能互相打断 |
| `NVIC_PriorityGroup_1` | 1 | 3 | 0 ~ 1 | 0 ~ 7 | 支持 |
| `NVIC_PriorityGroup_2` | 2 | 2 | 0 ~ 3 | 0 ~ 3 | 支持 |
| `NVIC_PriorityGroup_3` | 3 | 1 | 0 ~ 7 | 0 ~ 1 | 支持 |
| `NVIC_PriorityGroup_4` | 4 | 0 | 0 ~ 15 | 0 | 支持 |

- **抢占优先级**决定能否打断正在执行的中断，即嵌套关系；
- **子优先级**仅在同一抢占级的多个中断同时挂起时决定执行顺序，**不产生嵌套**；
- 分组是**全局设置**，`NVIC_PriorityGroupConfig()` 在整个工程中**只应调用一次**（通常置于 `main()` 初始化起始处）。若多个模块各自调用，后调用者会覆盖先前设置，抢占与子优先级的实际含义将随之改变。

本例采用 `NVIC_PriorityGroup_2` + 抢占 2 + 子优先级 2，SPL 最终写入 `NVIC->IP[EXTI0_IRQn]` 的值为 `0xA0`：

```
0b1010_0000
  └┬┘└┬┘
   │  └─ 子优先级 = 0b10 = 2
   └──── 抢占优先级 = 0b10 = 2
```

调试时可在寄存器窗口查看 `NVIC->IP[6]`（`EXTI0_IRQn == 6`）以验证其值为 `0xA0`。

### 6. 中断服务程序：命名、判断与清标志

```c
void EXTI0_IRQHandler(void)
{
    if (EXTI_GetITStatus(EXTI_Line0) != RESET)
    {
        GPIO_ToggleBits(GPIOC, GPIO_Pin_13);
        EXTI_ClearITPendingBit(EXTI_Line0);
    }
}
```

1. **函数名必须与 `startup_stm32f411xe.s` 的向量表一致**。启动文件中各入口均为弱定义：

   ```asm
   .weak      EXTI0_IRQHandler
   .thumb_set EXTI0_IRQHandler,Default_Handler
   ```

   若函数名拼写有误（例如写成 `EXTIO_IRQHandler`），编译不会报错，但会链接至 `Default_Handler` 的无限循环，表现为程序失控。

2. **进入 ISR 后应先判断标志**，确认挂起源，再执行处理。多个引脚共用同一向量时，这一步尤为必要。

3. **必须清除挂起标志**。`EXTI_ClearITPendingBit()` 的实质是向 `EXTI->PR` 的对应位**写 1**；若不清除，标志将一直有效，退出 ISR 后会立即再次进入，表现为中断被反复触发。

4. **ISR 应尽量简短**：不应在其中执行延时、串口打印等耗时操作，否则会延长中断响应时间，甚至丢失后续中断。

此外需注意向量的**共享关系**：`EXTI0_IRQHandler` 服务于所有映射到 EXTI0 的引脚（PA0/PB0/…），`EXTI15_10_IRQHandler` 则服务于 EXTI10 ~ EXTI15。若同时使用 PA0 与 PB0，须在 ISR 内进一步判断具体引脚。

## 四、寄存器级实现对照

若不依赖 SPL，前述各步骤均可由寄存器操作等价实现：

```c
/* 1. 时钟使能 */
RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN | RCC_AHB1ENR_GPIOCEN;
RCC->APB2ENR |= RCC_APB2ENR_SYSCFGEN;

/* 2. PA0 上拉输入；PC13 推挽输出 */
GPIOA->MODER &= ~GPIO_MODER_MODER0;                                        /* 00 = 输入 */
GPIOA->PUPDR  = (GPIOA->PUPDR & ~GPIO_PUPDR_PUPDR0) | GPIO_PUPDR_PUPDR0_0;  /* 01 = 上拉 */
GPIOC->MODER  = (GPIOC->MODER & ~GPIO_MODER_MODER13) | GPIO_MODER_MODER13_0;/* 01 = 输出 */
GPIOC->OTYPER &= ~GPIO_OTYPER_OT13;                                        /* 0 = 推挽 */

/* 3. EXTI0 ← PA0 */
SYSCFG->EXTICR[0] &= ~SYSCFG_EXTICR1_EXTI0;   /* 0b0000 = 端口 A */

/* 4. EXTI0：使能屏蔽位，选择下降沿 */
EXTI->IMR  |=  EXTI_IMR_MR0;
EXTI->RTSR &= ~EXTI_RTSR_TR0;
EXTI->FTSR |=  EXTI_FTSR_TR0;

/* 5. NVIC：分组 2（抢占 2 位 / 子优先级 2 位），抢占 = 2、子优先级 = 2 → 0xA0 */
NVIC_SetPriorityGrouping(NVIC_PRIORITYGROUP_2);
NVIC_SetPriority(EXTI0_IRQn, (2 << 6) | (2 << 4));
NVIC_EnableIRQ(EXTI0_IRQn);

/* 6. 清挂起标志（写 1 清零） */
void EXTI0_IRQHandler(void)
{
    if (EXTI->PR & EXTI_PR_PR0)
    {
        EXTI->PR = EXTI_PR_PR0;          /* 写 1 清除 */
        GPIOC->ODR ^= GPIO_ODR_OD13;     /* 翻转 PC13 电平 */
    }
}
```

需注意 `NVIC_SetPriority()` 接受的是**未经分组解释的完整优先级字段**，因此必须自行按位数移位；上式 `(2 << 6) | (2 << 4)` 的计算结果即为 `0xA0`，与 SPL 中 `NVIC_Init` 的结果完全一致。

## 五、常见问题与排查思路

| 现象 | 可能原因 |
| ---- | -------- |
| 完全不触发中断 | 未使能 SYSCFG 时钟；未调用 `SYSCFG_EXTILineConfig` 或端口选择有误；NVIC 通道未使能；触发边沿选择与实际电平变化相反（按键为按下接地却配置为上升沿） |
| 程序失控或进入死循环 | ISR 函数名与启动文件向量表不一致，落入 `Default_Handler`；或触发 HardFault |
| 反复进入中断 | 未清除 `EXTI->PR` 挂起标志；ISR 中存在无法满足的等待条件 |
| 按一次键触发多次 | 机械按键抖动，需 10 ~ 20 ms 软件消抖，或增加 RC 滤波 |
| 更换引脚后失效 | 同一 EXTI 线已被 SYSCFG 分配给其他端口；或该引脚未配置为输入 |
| 优先级行为与预期不符 | `NVIC_PriorityGroupConfig` 被多处调用而互相覆盖；抢占优先级取值超出当前分组的取值范围（分组 2 时为 0 ~ 3） |
| LED 亮度异常或驱动不足 | PC13 属备份域，限 2 MHz / 3 mA；且多数开发板的 LED 为低电平点亮 |

调试建议：在 ISR 内设置断点最为直接；亦可在变量窗口观察 `EXTI->PR`、`EXTI->IMR`、`NVIC->ISER[0]` 与 `NVIC->IP[6]`，据此定位到具体环节。

## 六、代码优化建议

1. **`TimingDelay` 当前不会发生递减**。`stm32f4xx_it.c` 的 `SysTick_Handler()` 已调用 `TimingDelay_Decrement()`，但 `main()` 中缺少 `SysTick_Config()`，系统节拍中断未使能，计数恒为 0。若后续需要软件延时，应先行补充：

   ```c
   /* 系统节拍 1 ms 中断（SystemCoreClock = 100 MHz 时） */
   if (SysTick_Config(SystemCoreClock / 1000))
   {
       while (1);   /* 配置失败 */
   }
   ```

2. **将中断初始化封装为独立函数**，`main()` 仅保留调用，以提高可读性与复用性；ISR 建议统一置于 `stm32f4xx_it.c`（置于 `main.c` 亦可正常运行）：

   ```c
   static void EXTI0_Config(void)
   {
       GPIO_InitTypeDef GPIO_Struct;
       EXTI_InitTypeDef EXTI_Struct;
       NVIC_InitTypeDef NVIC_Struct;

       RCC_AHB1PeriphClockCmd(RCC_AHB1Periph_GPIOA | RCC_AHB1Periph_GPIOC, ENABLE);
       RCC_APB2PeriphClockCmd(RCC_APB2Periph_SYSCFG, ENABLE);

       GPIO_Struct.GPIO_Mode  = GPIO_Mode_IN;
       GPIO_Struct.GPIO_OType = GPIO_OType_PP;   /* 输入模式不使用，显式赋值以避免读取未初始化成员 */
       GPIO_Struct.GPIO_Pin   = GPIO_Pin_0;
       GPIO_Struct.GPIO_PuPd  = GPIO_PuPd_UP;
       GPIO_Struct.GPIO_Speed = GPIO_Fast_Speed;
       GPIO_Init(GPIOA, &GPIO_Struct);

       SYSCFG_EXTILineConfig(EXTI_PortSourceGPIOA, EXTI_PinSource0);

       EXTI_Struct.EXTI_Line    = EXTI_Line0;
       EXTI_Struct.EXTI_Mode    = EXTI_Mode_Interrupt;
       EXTI_Struct.EXTI_Trigger = EXTI_Trigger_Falling;
       EXTI_Struct.EXTI_LineCmd = ENABLE;
       EXTI_Init(&EXTI_Struct);

       NVIC_PriorityGroupConfig(NVIC_PriorityGroup_2);
       NVIC_Struct.NVIC_IRQChannel                   = EXTI0_IRQn;
       NVIC_Struct.NVIC_IRQChannelPreemptionPriority = 2;
       NVIC_Struct.NVIC_IRQChannelSubPriority        = 2;
       NVIC_Struct.NVIC_IRQChannelCmd                = ENABLE;
       NVIC_Init(&NVIC_Struct);
   }
   ```

   如此，`main()` 中仅保留 PC13 的 LED 初始化、`EXTI0_Config()` 调用与主循环。

## 七、小结

外部中断的配置可归纳为一条固定流程：

> **使能时钟（GPIO 与 SYSCFG）→ 配置引脚输入与上下拉 → SYSCFG 完成线到端口的映射 → EXTI 设定触发边沿并使能 → NVIC 设定分组、优先级并使能通道 → ISR 内判断标志、执行处理、清除标志。**

对于定时器、串口、ADC 等外设中断，只需将上述第 3、4 步替换为相应外设的中断使能（`TIM_ITConfig`、`USART_ITConfig` 等），其骨架——**时钟 → 外设中断使能 → NVIC → ISR 清标志**——完全相同。
