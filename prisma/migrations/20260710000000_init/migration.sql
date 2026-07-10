-- CreateTable
CREATE TABLE `admin_users` (
    `id` VARCHAR(191) NOT NULL,
    `username` VARCHAR(80) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `admin_users_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customers` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `loginUsername` VARCHAR(100) NOT NULL,
    `loginPasswordHash` VARCHAR(255) NOT NULL,
    `email` VARCHAR(160) NULL,
    `phone` VARCHAR(60) NULL,
    `balance` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `remark` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `customers_loginUsername_key`(`loginUsername`),
    INDEX `customers_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `xui_servers` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `baseUrl` VARCHAR(500) NOT NULL,
    `username` VARCHAR(120) NULL,
    `passwordEnc` TEXT NULL,
    `tokenEnc` TEXT NULL,
    `basePath` VARCHAR(120) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `remark` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `xui_servers_enabled_idx`(`enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `service_nodes` (
    `id` VARCHAR(191) NOT NULL,
    `serverId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `inboundId` INTEGER NULL,
    `protocol` VARCHAR(40) NOT NULL DEFAULT 'vless',
    `priceMonthly` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `trafficLimitGb` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `config` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `remark` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `service_nodes_serverId_idx`(`serverId`),
    INDEX `service_nodes_enabled_idx`(`enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_nodes` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `serviceNodeId` VARCHAR(191) NOT NULL,
    `xuiEmail` VARCHAR(160) NOT NULL,
    `uuid` VARCHAR(80) NULL,
    `expireAt` DATETIME(3) NULL,
    `trafficLimitGb` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `usedTrafficGb` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `lastSyncedAt` DATETIME(3) NULL,
    `config` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `customer_nodes_status_idx`(`status`),
    INDEX `customer_nodes_expireAt_idx`(`expireAt`),
    UNIQUE INDEX `customer_nodes_customerId_serviceNodeId_key`(`customerId`, `serviceNodeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `socks_nodes` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `host` VARCHAR(255) NOT NULL,
    `port` INTEGER NOT NULL,
    `username` VARCHAR(120) NULL,
    `passwordEnc` TEXT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `remark` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `socks_nodes_enabled_idx`(`enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `card_batches` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cards` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NULL,
    `codeHash` VARCHAR(255) NOT NULL,
    `codePreview` VARCHAR(32) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('unused', 'used', 'disabled') NOT NULL DEFAULT 'unused',
    `usedById` VARCHAR(191) NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cards_codeHash_key`(`codeHash`),
    INDEX `cards_status_idx`(`status`),
    INDEX `cards_batchId_idx`(`batchId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_channels` (
    `id` VARCHAR(191) NOT NULL,
    `provider` ENUM('alipay', 'wechat', 'epay', 'bepusdt') NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `configEnc` JSON NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `payment_channels_provider_enabled_idx`(`provider`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recharge_orders` (
    `id` VARCHAR(191) NOT NULL,
    `tradeNo` VARCHAR(80) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NULL,
    `provider` ENUM('alipay', 'wechat', 'epay', 'bepusdt') NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('pending', 'paid', 'closed', 'failed') NOT NULL DEFAULT 'pending',
    `paidAt` DATETIME(3) NULL,
    `payUrl` TEXT NULL,
    `qrCode` TEXT NULL,
    `rawPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `recharge_orders_tradeNo_key`(`tradeNo`),
    INDEX `recharge_orders_customerId_idx`(`customerId`),
    INDEX `recharge_orders_provider_status_idx`(`provider`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_callbacks` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NULL,
    `provider` ENUM('alipay', 'wechat', 'epay', 'bepusdt') NOT NULL,
    `tradeNo` VARCHAR(80) NULL,
    `verified` BOOLEAN NOT NULL DEFAULT false,
    `idempotencyKey` VARCHAR(160) NULL,
    `payload` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_callbacks_idempotencyKey_key`(`idempotencyKey`),
    INDEX `payment_callbacks_provider_tradeNo_idx`(`provider`, `tradeNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `balance_logs` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `type` ENUM('card_redeem', 'recharge', 'renewal', 'admin_add', 'admin_subtract', 'admin_set', 'refund') NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `beforeBalance` DECIMAL(12, 2) NOT NULL,
    `afterBalance` DECIMAL(12, 2) NOT NULL,
    `operator` VARCHAR(120) NULL,
    `remark` TEXT NULL,
    `detail` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `balance_logs_customerId_createdAt_idx`(`customerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `renewal_logs` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `customerNodeId` VARCHAR(191) NULL,
    `months` INTEGER NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('success', 'failed') NOT NULL,
    `beforeExpireAt` DATETIME(3) NULL,
    `afterExpireAt` DATETIME(3) NULL,
    `detail` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `renewal_logs_customerId_createdAt_idx`(`customerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_logs` (
    `id` VARCHAR(191) NOT NULL,
    `serverId` VARCHAR(191) NULL,
    `action` VARCHAR(80) NOT NULL,
    `status` VARCHAR(40) NOT NULL,
    `message` TEXT NULL,
    `detail` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sync_logs_serverId_createdAt_idx`(`serverId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_settings` (
    `key` VARCHAR(120) NOT NULL,
    `value` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(191) NOT NULL,
    `adminUserId` VARCHAR(191) NULL,
    `action` VARCHAR(120) NOT NULL,
    `targetType` VARCHAR(80) NULL,
    `targetId` VARCHAR(80) NULL,
    `detail` JSON NULL,
    `ip` VARCHAR(80) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_action_createdAt_idx`(`action`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `service_nodes` ADD CONSTRAINT `service_nodes_serverId_fkey` FOREIGN KEY (`serverId`) REFERENCES `xui_servers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_nodes` ADD CONSTRAINT `customer_nodes_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_nodes` ADD CONSTRAINT `customer_nodes_serviceNodeId_fkey` FOREIGN KEY (`serviceNodeId`) REFERENCES `service_nodes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cards` ADD CONSTRAINT `cards_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `card_batches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cards` ADD CONSTRAINT `cards_usedById_fkey` FOREIGN KEY (`usedById`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recharge_orders` ADD CONSTRAINT `recharge_orders_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recharge_orders` ADD CONSTRAINT `recharge_orders_channelId_fkey` FOREIGN KEY (`channelId`) REFERENCES `payment_channels`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_callbacks` ADD CONSTRAINT `payment_callbacks_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `recharge_orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `balance_logs` ADD CONSTRAINT `balance_logs_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `renewal_logs` ADD CONSTRAINT `renewal_logs_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `renewal_logs` ADD CONSTRAINT `renewal_logs_customerNodeId_fkey` FOREIGN KEY (`customerNodeId`) REFERENCES `customer_nodes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sync_logs` ADD CONSTRAINT `sync_logs_serverId_fkey` FOREIGN KEY (`serverId`) REFERENCES `xui_servers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_adminUserId_fkey` FOREIGN KEY (`adminUserId`) REFERENCES `admin_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

