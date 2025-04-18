import { defineStore } from 'pinia'
import {
  Wallet,
  isEvmWallet,
  MagicProvider,
  isCosmosWallet
} from '@injectivelabs/wallet-base'
import {
  MsgGrant,
  type Msgs,
  PrivateKey,
  msgsOrMsgExecMsgs,
  getEthereumAddress,
  getInjectiveAddress,
  getDefaultSubaccountId,
  MsgGrantWithAuthorization,
  ContractExecutionCompatAuthz,
  getGenericAuthorizationFromMessageType
  // NEPTUNE_USDT_CW20_CONTRACT
} from '@injectivelabs/sdk-ts'
import { StatusType } from '@injectivelabs/utils'
import { GeneralException } from '@injectivelabs/exceptions'
import {
  getAddresses,
  walletStrategy,
  msgBroadcaster,
  validateEvmWallet,
  validateCosmosWallet,
  confirmCosmosWalletAddress,
  autoSignWalletStrategy,
  autoSignMsgBroadcaster,
  getEvmWalletProvider
} from '../WalletService'
import { IS_DEVNET, MSG_TYPE_URL_MSG_EXECUTE_CONTRACT } from '../utils/constant'
import {
  EventBus,
  type AutoSign,
  GrantDirection,
  WalletConnectStatus
} from '../types'

type WalletStoreState = {
  walletConnectStatus: WalletConnectStatus
  address: string
  injectiveAddress: string
  addressConfirmation: string
  session: string
  addresses: string[]
  hwAddresses: string[]
  bitGetInstalled: boolean
  phantomInstalled: boolean
  metamaskInstalled: boolean
  okxWalletInstalled: boolean
  trustWalletInstalled: boolean
  wallet: Wallet
  queueStatus: StatusType
  isDev: boolean

  authZ: {
    address: string
    direction: GrantDirection
    injectiveAddress: string
    defaultSubaccountId: string
  }

  autoSign?: AutoSign
  privateKey: string
}

const initialStateFactory = (): WalletStoreState => ({
  walletConnectStatus: WalletConnectStatus.idle,
  address: '',
  injectiveAddress: '',
  addressConfirmation: '',
  session: '',
  addresses: [],
  hwAddresses: [],
  wallet: Wallet.Metamask,
  bitGetInstalled: false,
  phantomInstalled: false,
  metamaskInstalled: false,
  okxWalletInstalled: false,
  trustWalletInstalled: false,
  isDev: false,
  queueStatus: StatusType.Idle,

  authZ: {
    address: '',
    direction: GrantDirection.Grantee,
    injectiveAddress: '',
    defaultSubaccountId: ''
  },

  autoSign: {
    privateKey: '',
    injectiveAddress: '',
    expiration: 0,
    duration: 0
  },

  privateKey: ''
})

export const useSharedWalletStore = defineStore('sharedWallet', {
  state: (): WalletStoreState => initialStateFactory(),
  getters: {
    isUserConnected: (state) => {
      const addressConnectedAndConfirmed =
        !!state.address && !!state.addressConfirmation && !!state.session
      const hasAddresses = state.addresses.length > 0

      return (
        state.walletConnectStatus !== WalletConnectStatus.connecting &&
        hasAddresses &&
        addressConnectedAndConfirmed &&
        !!state.injectiveAddress
      )
    },

    isWalletExemptFromGasFee: (state) => {
      return !isCosmosWallet(state.wallet) && !IS_DEVNET
    },

    defaultSubaccountId: (state) => {
      if (!state.injectiveAddress) {
        return undefined
      }

      return getDefaultSubaccountId(state.injectiveAddress)
    },

    isAuthzWalletConnected: (state) => {
      const addressConnectedAndConfirmed =
        !!state.address && !!state.addressConfirmation
      const hasAddresses = state.addresses.length > 0
      const isUserWalletConnected =
        hasAddresses && addressConnectedAndConfirmed && !!state.injectiveAddress

      return (
        isUserWalletConnected &&
        !!state.authZ.address &&
        !!state.authZ.injectiveAddress
      )
    },

    authZOrInjectiveAddress: (state) => {
      return state.authZ.injectiveAddress || state.injectiveAddress
    },

    authZOrDefaultSubaccountId: (state) => {
      return (
        state.authZ.defaultSubaccountId ||
        (state.injectiveAddress &&
          getDefaultSubaccountId(state.injectiveAddress)) ||
        ''
      )
    },

    authZOrAddress: (state) => {
      return state.authZ.address || state.address
    },

    isAutoSignEnabled: (state) => {
      if (!state.autoSign) {
        return false
      }

      if (!state.autoSign.injectiveAddress || !state.autoSign.privateKey) {
        return false
      }

      if (!state.autoSign.expiration || !state.autoSign.duration) {
        return false
      }

      return true
    }
  },
  actions: {
    async validate() {
      const walletStore = useSharedWalletStore()

      if (walletStore.autoSign) {
        return
      }

      if (
        [
          Wallet.BitGet,
          Wallet.Phantom,
          Wallet.Metamask,
          Wallet.OkxWallet,
          Wallet.TrustWallet
        ].includes(walletStore.wallet)
      ) {
        await validateEvmWallet({
          wallet: walletStore.wallet,
          address: walletStore.address
        })
      }

      if (
        [
          Wallet.Leap,
          Wallet.Ninji,
          Wallet.Keplr,
          Wallet.OWallet,
          Wallet.Cosmostation
        ].includes(walletStore.wallet)
      ) {
        await validateCosmosWallet({
          wallet: walletStore.wallet,
          address: walletStore.injectiveAddress
        })
      }
    },

    queue() {
      const walletStore = useSharedWalletStore()

      if (walletStore.queueStatus === StatusType.Loading) {
        throw new GeneralException(new Error('You have a pending transaction.'))
      } else {
        walletStore.$patch({
          queueStatus: StatusType.Loading
        })
      }
    },

    async validateAndQueue() {
      const sharedWalletStore = useSharedWalletStore()

      await sharedWalletStore.validate()

      sharedWalletStore.queue()
    },

    async init() {
      const walletStore = useSharedWalletStore()

      walletStore.walletConnectStatus = WalletConnectStatus.idle

      await walletStrategy.setWallet(walletStore.wallet)

      if (walletStore.wallet === Wallet.Magic && !walletStore.isUserConnected) {
        await walletStore.connectMagic()
      }

      if (walletStore.autoSign) {
        autoSignWalletStrategy.setOptions({
          privateKey: walletStore.autoSign.privateKey as string
        })
      }

      if (walletStore.privateKey) {
        walletStore.connectWallet(Wallet.PrivateKey, {
          privateKey: walletStore.privateKey
        })
      }
    },

    onConnect() {
      const modalStore = useSharedModalStore()
      const walletStore = useSharedWalletStore()

      modalStore.closeAll()

      walletStore.$patch({
        walletConnectStatus: WalletConnectStatus.connected
      })

      useEventBus(EventBus.WalletConnected).emit()
    },

    async checkIsMetamaskInstalled() {
      const walletStore = useSharedWalletStore()

      walletStore.$patch({
        metamaskInstalled: await !!getEvmWalletProvider(Wallet.Metamask)
      })
    },

    async checkIsTrustWalletInstalled() {
      const walletStore = useSharedWalletStore()

      walletStore.$patch({
        trustWalletInstalled: await !!getEvmWalletProvider(Wallet.TrustWallet)
      })
    },

    async checkIsOkxWalletInstalled() {
      const walletStore = useSharedWalletStore()

      walletStore.$patch({
        okxWalletInstalled: await !!getEvmWalletProvider(Wallet.OkxWallet)
      })
    },

    async checkIsBitGetInstalled() {
      const walletStore = useSharedWalletStore()

      walletStore.$patch({
        bitGetInstalled: await !!getEvmWalletProvider(Wallet.BitGet)
      })
    },

    async checkIsPhantomWalletInstalled() {
      const walletStore = useSharedWalletStore()

      walletStore.$patch({
        phantomInstalled: await !!getEvmWalletProvider(Wallet.Phantom)
      })
    },

    async connectWallet(wallet: Wallet, options?: { privateKey: string }) {
      const walletStore = useSharedWalletStore()

      /**
       * We should disconnect only if there are no hardware wallets connected
       * and we still haven't fetched any addresses and we've already connected
       * so there is no need to disconnect
       */
      if (walletStore.hwAddresses.length === 0) {
        await walletStrategy.disconnect()
      }

      await walletStrategy.setWallet(wallet)

      if (options?.privateKey) {
        walletStrategy.setOptions({ privateKey: options.privateKey })
      }

      walletStore.$patch({
        wallet
      })

      if (wallet !== Wallet.PrivateKey) {
        walletStore.$patch({
          walletConnectStatus: WalletConnectStatus.connecting
        })
      }
    },

    async getHWAddresses(wallet: Wallet) {
      const walletStore = useSharedWalletStore()

      if (
        walletStore.hwAddresses.length === 0 ||
        walletStore.wallet !== wallet
      ) {
        walletStrategy.disconnect()
        walletStrategy.setWallet(wallet)

        walletStore.$patch({
          wallet
        })

        const addresses = await getAddresses()

        const injectiveAddresses = isEvmWallet(wallet)
          ? addresses.map(getInjectiveAddress)
          : addresses

        walletStore.$patch({
          hwAddresses: injectiveAddresses
        })
      } else {
        const addresses = await getAddresses()
        const injectiveAddresses = isEvmWallet(wallet)
          ? addresses.map(getInjectiveAddress)
          : addresses

        walletStore.$patch({
          hwAddresses: [...walletStore.hwAddresses, ...injectiveAddresses]
        })
      }
    },

    async connectCosmosStation() {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.Cosmostation)

      const injectiveAddresses = await getAddresses()
      const [injectiveAddress] = injectiveAddresses
      const session = await walletStrategy.getSessionOrConfirm()

      walletStore.$patch({
        injectiveAddress,
        addresses: injectiveAddresses,
        address: getEthereumAddress(injectiveAddress),
        addressConfirmation: await walletStrategy.getSessionOrConfirm(
          injectiveAddress
        ),
        session
      })

      await walletStore.onConnect()
    },

    async connectNinji() {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.Ninji)

      const injectiveAddresses = await getAddresses()
      const [injectiveAddress] = injectiveAddresses
      const session = await walletStrategy.getSessionOrConfirm()

      walletStore.$patch({
        injectiveAddress,
        addresses: injectiveAddresses,
        address: getEthereumAddress(injectiveAddress),
        addressConfirmation: await walletStrategy.getSessionOrConfirm(
          injectiveAddress
        ),
        session
      })

      await walletStore.onConnect()
    },

    async connectKeplr() {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.Keplr)

      const injectiveAddresses = await getAddresses()
      const [injectiveAddress] = injectiveAddresses
      const session = await walletStrategy.getSessionOrConfirm()

      await confirmCosmosWalletAddress(Wallet.Keplr, injectiveAddress)

      walletStore.$patch({
        injectiveAddress,
        addresses: injectiveAddresses,
        address: getEthereumAddress(injectiveAddress),
        addressConfirmation: await walletStrategy.getSessionOrConfirm(
          injectiveAddress
        ),
        session
      })

      await walletStore.onConnect()
    },

    async connectLedger({
      wallet,
      address
    }: {
      wallet: Wallet
      address: string
    }) {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(wallet)

      const ethereumAddress = getEthereumAddress(address)
      const session = await walletStrategy.getSessionOrConfirm(ethereumAddress)

      walletStore.$patch({
        address: ethereumAddress,
        injectiveAddress: address,
        addresses: [ethereumAddress],
        addressConfirmation: await walletStrategy.getSessionOrConfirm(
          ethereumAddress
        ),
        session
      })

      await walletStore.onConnect()
    },

    async connectLedgerCosmos(injectiveAddress: string) {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.LedgerCosmos)

      const ethereumAddress = getEthereumAddress(injectiveAddress)
      const session = await walletStrategy.getSessionOrConfirm()

      walletStore.$patch({
        injectiveAddress,
        address: ethereumAddress,
        addresses: [ethereumAddress],
        addressConfirmation: await walletStrategy.getSessionOrConfirm(
          injectiveAddress
        ),
        session
      })

      await walletStore.onConnect()
    },

    async connectLeap() {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.Leap)

      const injectiveAddresses = await getAddresses()
      const [injectiveAddress] = injectiveAddresses
      const session = await walletStrategy.getSessionOrConfirm()

      walletStore.$patch({
        injectiveAddress,
        addresses: injectiveAddresses,
        address: getEthereumAddress(injectiveAddress),
        addressConfirmation: await walletStrategy.getSessionOrConfirm(
          injectiveAddress
        ),
        session
      })

      await walletStore.onConnect()
    },

    async connectMetamask() {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.Metamask)

      const addresses = await getAddresses()
      const [address] = addresses
      const session = await walletStrategy.getSessionOrConfirm(address)

      walletStore.$patch({
        addresses,
        address,
        injectiveAddress: getInjectiveAddress(address),
        addressConfirmation: await walletStrategy.getSessionOrConfirm(address),
        session
      })

      await walletStore.onConnect()
    },

    async connectTrezor({
      wallet,
      address
    }: {
      wallet: Wallet
      address: string
    }) {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(wallet)

      const ethereumAddress = getEthereumAddress(address)
      const session = await walletStrategy.getSessionOrConfirm(ethereumAddress)

      walletStore.$patch({
        address: ethereumAddress,
        injectiveAddress: address,
        addresses: [ethereumAddress],
        addressConfirmation: await walletStrategy.getSessionOrConfirm(
          ethereumAddress
        ),
        session
      })

      await walletStore.onConnect()
    },

    async connectTrustWallet() {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.TrustWallet)

      const addresses = await getAddresses()
      const [address] = addresses
      const session = await walletStrategy.getSessionOrConfirm(address)

      walletStore.$patch({
        address,
        addresses,
        injectiveAddress: getInjectiveAddress(address),
        addressConfirmation: await walletStrategy.getSessionOrConfirm(address),
        session
      })

      await walletStore.onConnect()
    },

    async connectWalletConnect() {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.WalletConnect)

      const addresses = await getAddresses()

      const [address] = addresses
      const session = await walletStrategy.getSessionOrConfirm(address)

      walletStore.$patch({
        address,
        addresses,
        addressConfirmation: await walletStrategy.getSessionOrConfirm(address),
        injectiveAddress: getInjectiveAddress(address),
        session
      })

      await walletStore.onConnect()
    },

    async connectOkxWallet() {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.OkxWallet)

      const addresses = await getAddresses()
      const [address] = addresses
      const session = await walletStrategy.getSessionOrConfirm(address)

      walletStore.$patch({
        address,
        addresses,
        addressConfirmation: await walletStrategy.getSessionOrConfirm(address),
        injectiveAddress: getInjectiveAddress(address),
        session
      })

      await walletStore.onConnect()
    },

    async connectPhantomWallet() {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.Phantom)

      const addresses = await getAddresses()
      const [address] = addresses
      const session = await walletStrategy.getSessionOrConfirm(address)

      walletStore.$patch({
        address,
        addresses,
        addressConfirmation: await walletStrategy.getSessionOrConfirm(address),
        injectiveAddress: getInjectiveAddress(address),
        session
      })

      await walletStore.onConnect()
    },

    async connectBitGet() {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.BitGet)

      const addresses = await getAddresses()
      const [address] = addresses
      const session = await walletStrategy.getSessionOrConfirm(address)

      walletStore.$patch({
        address,
        addresses,
        addressConfirmation: await walletStrategy.getSessionOrConfirm(address),
        injectiveAddress: getInjectiveAddress(address),
        session
      })

      await walletStore.onConnect()
    },

    async connectMagic(provider?: MagicProvider, email?: string) {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.Magic)

      try {
        const [address] = await getAddresses({ email, provider })

        if (!address) {
          return
        }

        const ethereumAddress = getEthereumAddress(address)
        const session = await walletStrategy.getSessionOrConfirm(address)

        walletStore.$patch({
          address: ethereumAddress,
          addresses: [ethereumAddress],
          addressConfirmation: await walletStrategy.getSessionOrConfirm(
            address
          ),
          injectiveAddress: address,
          session
        })

        await walletStore.onConnect()
      } catch (e: any) {
        walletStore.wallet = initialStateFactory().wallet
        walletStore.walletConnectStatus = WalletConnectStatus.idle
      }
    },

    async connectAddress(injectiveAddress: string) {
      const walletStore = useSharedWalletStore()

      await walletStore.connectWallet(Wallet.Metamask)

      const addresses = [getEthereumAddress(injectiveAddress)]
      const [address] = addresses
      const session = await walletStrategy.getSessionOrConfirm(address)

      walletStore.$patch({
        address,
        addresses,
        injectiveAddress,
        addressConfirmation: await walletStrategy.getSessionOrConfirm(address),
        session,
        isDev: true
      })

      await walletStore.onConnect()
    },

    async connectPrivateKey(privateKeyHash: string) {
      const walletStore = useSharedWalletStore()

      const pk = PrivateKey.fromHex(privateKeyHash)
      const injectiveAddress = pk.toBech32()

      await walletStore.connectWallet(Wallet.PrivateKey, {
        privateKey: privateKeyHash
      })

      const address = getEthereumAddress(injectiveAddress)
      const session = await walletStrategy.getSessionOrConfirm(address)

      walletStore.$patch({
        address,
        session,
        injectiveAddress,
        addresses: [address],
        addressConfirmation: await walletStrategy.getSessionOrConfirm(address),
        wallet: Wallet.PrivateKey,
        privateKey: privateKeyHash
      })

      await walletStore.onConnect()
    },

    prepareBroadcastMessages(messages: Msgs | Msgs[], memo?: string) {
      const walletStore = useSharedWalletStore()
      const msgs = Array.isArray(messages) ? messages : [messages]

      if (!walletStore.isUserConnected) {
        return
      }

      let actualMessage

      if (walletStore.isAutoSignEnabled && walletStore.isAuthzWalletConnected) {
        // error because we don't support authz + auto-sign
        throw new GeneralException(
          new Error('Authz and auto-sign cannot be used together')
        )

        // TODO: uncomment this when we support authz + auto-sign
        // actualMessage = msgsOrMsgExecMsgs(
        //   msgsOrMsgExecMsgs(msgs, walletStore.injectiveAddress),
        //   walletStore.autoSign.injectiveAddress
        // )
      } else if (walletStore.isAuthzWalletConnected) {
        actualMessage = msgsOrMsgExecMsgs(msgs, walletStore.injectiveAddress)
      } else {
        actualMessage = msgs
      }

      const broadcastOptions = {
        msgs: actualMessage,
        injectiveAddress: walletStore.injectiveAddress,
        memo
      }

      return broadcastOptions
    },

    async broadcastMessages(messages: Msgs | Msgs[], memo?: string) {
      const walletStore = useSharedWalletStore()
      const broadcastOptions = await walletStore.prepareBroadcastMessages(
        messages,
        memo
      )

      if (!broadcastOptions) {
        return
      }

      const msgs = Array.isArray(messages) ? messages : [messages]

      const hasMsgExecuteContract = msgs.some(
        (msg) =>
          JSON.parse(msg.toJSON())['@type'] ===
          MSG_TYPE_URL_MSG_EXECUTE_CONTRACT
      )

      if (
        walletStore.autoSign &&
        !hasMsgExecuteContract &&
        walletStore.isAutoSignEnabled
      ) {
        const response = await autoSignMsgBroadcaster.broadcastV2({
          msgs: msgsOrMsgExecMsgs(msgs, walletStore.autoSign.injectiveAddress),
          memo,
          injectiveAddress: walletStore.autoSign.injectiveAddress
        })

        return response
      }

      const response = await msgBroadcaster.broadcast(broadcastOptions)

      return response
    },

    async broadcastWithFeeDelegation({
      messages,
      memo
    }: {
      messages: Msgs | Msgs[]
      memo?: string
    }) {
      const walletStore = useSharedWalletStore()

      const broadcastOptions = await walletStore.prepareBroadcastMessages(
        messages,
        memo
      )

      if (!broadcastOptions) {
        return
      }

      const msgs = Array.isArray(messages) ? messages : [messages]

      const hasMsgExecuteContract = msgs.some((msg) => {
        const parsedMsg = JSON.parse(msg.toJSON())

        const isMsgExec =
          parsedMsg['@type'] === MSG_TYPE_URL_MSG_EXECUTE_CONTRACT

        return isMsgExec
      })

      if (
        walletStore.autoSign &&
        !hasMsgExecuteContract &&
        walletStore.isAutoSignEnabled
      ) {
        const msgExecMsgs = msgsOrMsgExecMsgs(
          msgs,
          walletStore.autoSign.injectiveAddress
        )

        const response =
          await autoSignMsgBroadcaster.broadcastWithFeeDelegation({
            memo,
            msgs: msgExecMsgs,
            injectiveAddress: walletStore.autoSign.injectiveAddress
          })

        return response
      }

      const response = await msgBroadcaster.broadcastWithFeeDelegation(
        broadcastOptions
      )

      return response
    },

    connectAuthZ(
      injectiveAddress: string,
      direction: GrantDirection = GrantDirection.Granter
    ) {
      const walletStore = useSharedWalletStore()

      walletStore.$patch({
        authZ: {
          direction,
          injectiveAddress,
          address: getEthereumAddress(injectiveAddress),
          defaultSubaccountId: getDefaultSubaccountId(injectiveAddress)
        }
      })

      walletStore.onConnect()
    },

    async connectAutoSign(
      msgsType: string[] = [],
      contractExecutionCompatAuthz: ContractExecutionCompatAuthz[] = []
    ) {
      if (msgsType.length === 0 && contractExecutionCompatAuthz.length === 0) {
        throw new GeneralException(new Error('No messages provided'))
      }

      const walletStore = useSharedWalletStore()

      const { privateKey } = PrivateKey.generate()
      const injectiveAddress = privateKey.toBech32()

      const nowInSeconds = Math.floor(Date.now() / 1000)
      const expirationInSeconds = 60 * 60 * 24 * 3 // 3 days

      const grantWithAuthorization = contractExecutionCompatAuthz.map(
        (authorization) =>
          MsgGrantWithAuthorization.fromJSON({
            authorization,
            grantee: injectiveAddress,
            granter: walletStore.injectiveAddress,
            expiration: nowInSeconds + expirationInSeconds
          })
      )

      const authZMsgs = msgsType.map((messageType) =>
        MsgGrant.fromJSON({
          grantee: injectiveAddress,
          granter: walletStore.injectiveAddress,
          expiration: nowInSeconds + expirationInSeconds,
          authorization: getGenericAuthorizationFromMessageType(messageType)
        })
      )

      await walletStore.broadcastWithFeeDelegation({
        messages: [...authZMsgs, ...grantWithAuthorization]
      })

      const autoSign = {
        injectiveAddress,
        privateKey: privateKey.toPrivateKeyHex(),
        expiration: nowInSeconds + expirationInSeconds,
        duration: expirationInSeconds
      }

      walletStore.$patch({
        autoSign
      })

      autoSignWalletStrategy.setOptions({
        privateKey: autoSign.privateKey
      })
    },

    async validateAutoSign(
      msgsType: string[] = [],
      contractExecutionCompatAuthz: ContractExecutionCompatAuthz[] = []
    ) {
      if (msgsType.length === 0 && contractExecutionCompatAuthz.length === 0) {
        throw new GeneralException(new Error('No messages provided'))
      }

      const walletStore = useSharedWalletStore()

      if (!walletStore.isAutoSignEnabled) {
        return
      }

      const autoSign = walletStore.autoSign as AutoSign
      const nowInSeconds = Math.floor(Date.now() / 1000)

      if (autoSign.expiration > nowInSeconds) {
        return
      }

      const expirationInSeconds = autoSign.duration || 3600

      const grantWithAuthorization = contractExecutionCompatAuthz.map(
        (authorization) =>
          MsgGrantWithAuthorization.fromJSON({
            authorization,
            grantee: autoSign.injectiveAddress,
            granter: walletStore.injectiveAddress,
            expiration: nowInSeconds + expirationInSeconds
          })
      )

      const authZMsgs = msgsType.map((messageType) =>
        MsgGrant.fromJSON({
          grantee: autoSign.injectiveAddress,
          granter: walletStore.injectiveAddress,
          expiration: nowInSeconds + expirationInSeconds,
          authorization: getGenericAuthorizationFromMessageType(messageType)
        })
      )

      await walletStore.connectWallet(walletStore.wallet)

      await walletStore.broadcastWithFeeDelegation({
        messages: [...authZMsgs, ...grantWithAuthorization]
      })

      walletStore.$patch((state) => {
        state.autoSign = {
          ...autoSign,
          expiration: expirationInSeconds
        }
      })
    },

    resetAuthZ() {
      const walletStore = useSharedWalletStore()

      walletStore.$patch({
        authZ: {
          address: '',
          defaultSubaccountId: '',
          direction: GrantDirection.Granter,
          injectiveAddress: ''
        }
      })

      walletStore.onConnect()
    },

    async disconnectAutoSign() {
      const walletStore = useSharedWalletStore()

      walletStore.$patch({
        autoSign: undefined
      })

      await autoSignWalletStrategy.disconnect()
    },

    async logout() {
      const walletStore = useSharedWalletStore()

      walletStore.walletConnectStatus = WalletConnectStatus.disconnecting

      await walletStrategy.disconnect()

      walletStore.$patch({
        ...initialStateFactory(),
        authZ: {
          address: '',
          defaultSubaccountId: '',
          direction: GrantDirection.Granter,
          injectiveAddress: ''
        },
        autoSign: undefined,
        queueStatus: StatusType.Idle,
        bitGetInstalled: walletStore.bitGetInstalled,
        phantomInstalled: walletStore.phantomInstalled,
        metamaskInstalled: walletStore.metamaskInstalled,
        okxWalletInstalled: walletStore.okxWalletInstalled,
        walletConnectStatus: WalletConnectStatus.disconnected,
        trustWalletInstalled: walletStore.trustWalletInstalled
      })

      useEventBus(EventBus.WalletDisconnected).emit()
    }
  }
})
