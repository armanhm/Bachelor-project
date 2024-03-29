import { BigNumber, BigNumberish } from 'ethers';
import {
    Address,
    TokenLike,
    Nonce,
    ChangePubKeyFee,
    SignedTransaction,
    TxEthSignature,
    ChangePubkeyTypes,
    TotalFee,
    Order
} from './types';
import { MAX_TIMESTAMP } from './utils';
import { AbstractWallet } from './abstract-wallet';

/**
 * Used by `BatchBuilder` to store transactions until the `build()` call.
 */
export interface BatchBuilderInternalTx {
    type: 'Withdraw' | 'Transfer' | 'ChangePubKey' | 'ForcedExit' | 'MintNFT' | 'WithdrawNFT' | 'Swap';
    tx: any;
    feeType:
        | 'Withdraw'
        | 'Transfer'
        | 'FastWithdraw'
        | 'ForcedExit'
        | ChangePubKeyFee
        | 'Swap'
        | 'MintNFT'
        | 'WithdrawNFT'
        | 'ForcedExit';
    address: Address;
    token: TokenLike;
    // Whether or not the tx has been signed.
    // Considered false by default
    alreadySigned?: boolean;
}

/**
 * Provides interface for constructing batches of transactions.
 */
export class BatchBuilder {
    private constructor(
        private wallet: AbstractWallet,
        private nonce: Nonce,
        private txs: BatchBuilderInternalTx[] = []
    ) {}

    static fromWallet(wallet: AbstractWallet, nonce?: Nonce): BatchBuilder {
        return new BatchBuilder(wallet, nonce, []);
    }

    /**
     * Construct the batch from the given transactions.
     * Returs it with the corresponding Ethereum signature and total fee.
     * @param feeToken If provided, the fee for the whole batch will be obtained from the server in this token.
     * Possibly creates phantom transfer.
     */
    async build(
        feeToken?: TokenLike
    ): Promise<{ txs: SignedTransaction[]; signature?: TxEthSignature; totalFee: TotalFee }> {
        if (this.txs.length == 0) {
            throw new Error('Transaction batch cannot be empty');
        }
        if (feeToken != undefined) {
            await this.setFeeToken(feeToken);
        }
        // Gather total fee for every token.
        const totalFee: TotalFee = new Map();
        for (const tx of this.txs) {
            const fee = tx.tx.fee;
            // Signed transactions store token ids instead of symbols.
            if (tx.alreadySigned) {
                tx.token = this.wallet.provider.tokenSet.resolveTokenSymbol(tx.tx.feeToken);
            }
            const token = tx.token;
            const curr: BigNumber = totalFee.get(token) || BigNumber.from(0);
            totalFee.set(token, curr.add(fee));
        }

        const { txs, signature } = await this.processTransactions();

        return {
            txs,
            signature,
            totalFee
        };
    }

    private async setFeeToken(feeToken: TokenLike) {
        // If user specified a token he wants to pay with, we expect all fees to be zero
        // and no signed transactions in the batch.
        if (this.txs.find((tx) => tx.alreadySigned || !BigNumber.from(tx.tx.fee).isZero()) != undefined) {
            throw new Error('All transactions are expected to be unsigned with zero fees');
        }
        // We use the last transaction in the batch for paying fees.
        // If it uses different token, create dummy transfer to self.
        if (this.txs[this.txs.length - 1].token !== feeToken) {
            this.addTransfer({
                to: this.wallet.address(),
                token: feeToken,
                amount: 0
            });
        }
        const txWithFeeToken = this.txs[this.txs.length - 1];

        const txTypes = this.txs.map((tx) => tx.feeType);
        const addresses = this.txs.map((tx) => tx.address);

        txWithFeeToken.tx.fee = await this.wallet.provider.getTransactionsBatchFee(txTypes, addresses, feeToken);
    }

    addWithdraw(withdraw: {
        ethAddress: string;
        token: TokenLike;
        amount: BigNumberish;
        fee?: BigNumberish;
        validFrom?: number;
        validUntil?: number;
    }): BatchBuilder {
        const _withdraw = {
            ethAddress: withdraw.ethAddress,
            token: withdraw.token,
            amount: withdraw.amount,
            fee: withdraw.fee || 0,
            nonce: null,
            validFrom: withdraw.validFrom || 0,
            validUntil: withdraw.validUntil || MAX_TIMESTAMP
        };
        this.txs.push({
            type: 'Withdraw',
            tx: _withdraw,
            feeType: 'Withdraw',
            address: _withdraw.ethAddress,
            token: _withdraw.token
        });
        return this;
    }

    addMintNFT(mintNFT: {
        recipient: string;
        contentHash: string;
        feeToken: TokenLike;
        fee?: BigNumberish;
    }): BatchBuilder {
        const _mintNft = {
            recipient: mintNFT.recipient,
            contentHash: mintNFT.contentHash,
            feeToken: mintNFT.feeToken,
            fee: mintNFT.fee || 0
        };
        this.txs.push({
            type: 'MintNFT',
            tx: _mintNft,
            feeType: 'MintNFT',
            address: _mintNft.recipient,
            token: _mintNft.feeToken
        });

        return this;
    }

    addWithdrawNFT(withdrawNFT: {
        to: string;
        token: TokenLike;
        feeToken: TokenLike;
        fee?: BigNumberish;
        validFrom?: number;
        validUntil?: number;
    }): BatchBuilder {
        const _withdrawNFT = {
            to: withdrawNFT.to,
            token: withdrawNFT.token,
            feeToken: withdrawNFT.feeToken,
            fee: withdrawNFT.fee || 0,
            validFrom: withdrawNFT.validFrom || 0,
            validUntil: withdrawNFT.validUntil || MAX_TIMESTAMP
        };
        this.txs.push({
            type: 'WithdrawNFT',
            tx: _withdrawNFT,
            feeType: 'WithdrawNFT',
            address: _withdrawNFT.to,
            token: _withdrawNFT.feeToken
        });

        return this;
    }

    addSwap(swap: {
        orders: [Order, Order];
        amounts: [BigNumberish, BigNumberish];
        feeToken: TokenLike;
        fee?: BigNumberish;
    }): BatchBuilder {
        const _swap = {
            orders: swap.orders,
            amounts: swap.amounts,
            nonce: null,
            fee: swap.fee || 0,
            feeToken: swap.feeToken
        };
        this.txs.push({
            type: 'Swap',
            tx: _swap,
            feeType: 'Swap',
            address: this.wallet.address(),
            token: swap.feeToken
        });
        return this;
    }

    addTransfer(transfer: {
        to: Address;
        token: TokenLike;
        amount: BigNumberish;
        fee?: BigNumberish;
        validFrom?: number;
        validUntil?: number;
    }): BatchBuilder {
        const _transfer = {
            to: transfer.to,
            token: transfer.token,
            amount: transfer.amount,
            fee: transfer.fee || 0,
            nonce: null,
            validFrom: transfer.validFrom || 0,
            validUntil: transfer.validUntil || MAX_TIMESTAMP
        };
        this.txs.push({
            type: 'Transfer',
            tx: _transfer,
            feeType: 'Transfer',
            address: _transfer.to,
            token: _transfer.token
        });
        return this;
    }

    addChangePubKey(
        changePubKey:
            | {
                  feeToken: TokenLike;
                  ethAuthType: ChangePubkeyTypes;
                  fee?: BigNumberish;
                  validFrom?: number;
                  validUntil?: number;
              }
            | SignedTransaction
    ): BatchBuilder {
        if ('tx' in changePubKey) {
            if (changePubKey.tx.type !== 'ChangePubKey') {
                throw new Error('Invalid transaction type: expected ChangePubKey');
            }
            // Already signed.
            this.txs.push({
                type: 'ChangePubKey',
                tx: changePubKey.tx,
                feeType: null, // Not needed.
                address: this.wallet.address(),
                token: null, // Will be resolved later.
                alreadySigned: true
            });
            return this;
        }
        const _changePubKey = {
            feeToken: changePubKey.feeToken,
            fee: changePubKey.fee || 0,
            nonce: null,
            ethAuthType: changePubKey.ethAuthType,
            validFrom: changePubKey.validFrom || 0,
            validUntil: changePubKey.validUntil || MAX_TIMESTAMP
        };
        const feeType = {
            ChangePubKey: changePubKey.ethAuthType
        };
        this.txs.push({
            type: 'ChangePubKey',
            tx: _changePubKey,
            feeType,
            address: this.wallet.address(),
            token: _changePubKey.feeToken
        });
        return this;
    }

    addForcedExit(forcedExit: {
        target: Address;
        token: TokenLike;
        fee?: BigNumberish;
        validFrom?: number;
        validUntil?: number;
    }): BatchBuilder {
        const _forcedExit = {
            target: forcedExit.target,
            token: forcedExit.token,
            fee: forcedExit.fee || 0,
            nonce: null,
            validFrom: forcedExit.validFrom || 0,
            validUntil: forcedExit.validUntil || MAX_TIMESTAMP
        };
        this.txs.push({
            type: 'ForcedExit',
            tx: _forcedExit,
            feeType: 'ForcedExit',
            address: _forcedExit.target,
            token: _forcedExit.token
        });
        return this;
    }

    /**
     * Sets transactions nonces, assembles the batch and constructs the message to be signed by user.
     */
    private async processTransactions(): Promise<{ txs: SignedTransaction[]; signature?: TxEthSignature }> {
        return await this.wallet.processBatchBuilderTransactions(this.nonce, this.txs);
    }
}
