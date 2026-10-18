+++
title = "Ubuntu下载及安装"
date = "2026-07-22T19:30:00+08:00"
draft = false
description = "详细阐释了如何进行Ubuntu安装"
categories = [ "Ubuntu" ]
tags = [ "Ubuntu", "系统", "Linux" ]
cover = "/images/pool/covers/covers-377.webp"
banner = ""
+++

（复制了自己以前的文章）
## **Ubuntu下载及安装（实体机）**

### **造锅：****下载**

下载网址(一种即可):

https://mirror.tuna.tsinghua.edu.cn/ubuntu-releases/清华大学开源软件镜像站 （速度较快）

https://mirrors.ustc.edu.cn/ubuntu-releases/中科大开源软件镜像站

以为清华站为例:

选择版本，这里我选择20.04(因为Ubuntu20.04较稳定好用)。单击20.04进入，然后选择ubuntu-20.04.6-live-server-amd64.iso下载

---

![IMG_256](images/ubuntu_install_files/image1.webp)

下载完成后找一个2G以上的可移动存储介质(如U盘，移动硬盘，最好找个速度快的)并插入计算机

下载Win32DiskImger:直接百度搜索就行

---

![IMG_257](images/ubuntu_install_files/image2.webp)

点击“映像文件”中的文件夹图标，再切换过滤文件类型(“打开”按钮上面，单击然后选择“.”）然后选择刚才下载的映像，如图

---

![IMG_258](images/ubuntu_install_files/image3.webp)

然后在“设备”中选择可移动介质的盘符，点击写入，等待写入完成

---

![IMG_259](images/ubuntu_install_files/image4.webp)

![IMG_260](images/ubuntu_install_files/image5.webp)

直到这样就好了

---

![IMG_261](images/ubuntu_install_files/image6.webp)

把可移动介质弹出并拔下，本步骤完成！

### **起锅:安装**

**警告：要安装Ubuntu的机器的磁盘将会被清除，请提前做好备份**

在要安装Ubuntu的机器中插入U盘，进入BIOS选择自己的U盘启动(都会吧)，热键查询：

---

![IMG_262](images/ubuntu_install_files/image7.webp)

安装过程中(不管哪一步)出现如图情况，请用上下方向键把光标移到\[Restart the installer\](重启安装程序)并回车

---

![IMG_263](images/ubuntu_install_files/image8.webp)

重启后会进入系统安装程序，如图界面会持续较长时间（电脑配置与加载时间成正比）,此外还有其他界面出现。

---

![IMG_264](images/ubuntu_install_files/image9.webp)

![IMG_265](images/ubuntu_install_files/image10.webp)

直到这个界面：

---

![IMG_266](images/ubuntu_install_files/image11.webp)

单击回车，然后会有类似这样的界面

---

![IMG_267](images/ubuntu_install_files/image12.webp)

点击回车

---

![IMG_268](images/ubuntu_install_files/image13.webp)

然后点击“↑”键（方向上键，在键盘上）三次，把光标移动到layout后面，点击回车选择Chinese

---

![IMG_269](images/ubuntu_install_files/image14.webp)

回车，然后点击“↓”键三次：

---

![IMG_270](images/ubuntu_install_files/image15.webp)

回车

---

![IMG_271](images/ubuntu_install_files/image16.webp)

上面图片内容略有差异正常，直接点击回车 

---

![IMG_272](images/ubuntu_install_files/image17.webp)

不是用代理直接点回车（一般不用），用代理的点击↑键输入代理地址再回车

---

![IMG_273](images/ubuntu_install_files/image18.webp)

点击↑键，然后把框中地址修改为https://mirror.tuna.tsinghua.edu.cn/

上面这步叫做换源

然后点击↓键，回车

---

![IMG_274](images/ubuntu_install_files/image19.webp)

不懂的先利用上下键把光标移动到“\[X\] Set up this disk as an LVM group”的X底下，点击回车。使X消失。然后把光标移动到\[Done\]，使\[Done\]底色变为绿色，如图

---

![IMG_275](images/ubuntu_install_files/image20.webp)

回车

---

![IMG_276](images/ubuntu_install_files/image21.webp)

分区选择，可以直接回车(回车会利用整个磁盘哦)(小白选择)，或者设置磁盘（高级玩家）

---

![IMG_277](images/ubuntu_install_files/image22.webp)

先点击下键，把光标移动到“Continue”（即“Continue”按钮背景变红）

---

![IMG_278](images/ubuntu_install_files/image23.webp)

回车，填写完直接回车填写下一行（光标框是暗灰色的，其他框是亮白色），注意电脑名和用户名“只能由0~9，a~z(小写)，-(减号)和\_(下划线)组成”，不然要报错

---

![IMG_279](images/ubuntu_install_files/image24.webp)

PS.WS部落阁=WSBlog，是本人的，文章首可证明

输入完最后一行单击回车

---

![IMG_280](images/ubuntu_install_files/image25.webp)

回车，点两次下键，把光标移动到\[Done\],回车

---

![IMG_281](images/ubuntu_install_files/image26.webp)

小白在这一步可以按下键把光标移动到\[Done\]处，高端玩家可以看看选择预装软件

开始安装：（无需操作）

---

![IMG_282](images/ubuntu_install_files/image27.webp)

当安装完成后，上方橙色条的字会变成“Install Complete”（相似即可，一定有complete这个单词）

此时按下键把光标移动到\[Reboot Now\]处（底色变绿）单击回车即可完成安装

### **安装完成！**
