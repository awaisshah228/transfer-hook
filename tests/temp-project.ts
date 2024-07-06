import * as anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getExtraAccountMetaAddress,
  getExtraAccountMetas,
  getMint,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  getTransferHook,
} from '@solana/spl-token';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import type { TransferHook } from '../target/types/transfer_hook';
import { Program } from "@coral-xyz/anchor"
import { expect } from "chai"

describe('transfer-hook', () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TransferHook as Program<TransferHook>;
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  // Generate keypair to use as address for the transfer-hook enabled mint
  const mint = new Keypair();
  const decimals = 9;

  // Sender token account address
  const sourceTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Recipient token account address
  const recipient = Keypair.generate();
  const destinationTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    recipient.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // PDA delegate to transfer wSOL tokens from sender
  const [delegatePDA] = PublicKey.findProgramAddressSync([Buffer.from('delegate')], program.programId);

  // Sender wSOL token account address
  const senderWSolTokenAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT, // mint
    wallet.publicKey, // owner
  );

  // Delegate PDA wSOL token account address, to receive wSOL tokens from sender
  const delegateWSolTokenAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT, // mint
    delegatePDA, // owner
    true, // allowOwnerOffCurve
  );

  // Create the two WSol token accounts as part of setup
  before(async () => {
    // WSol Token Account for sender
    await getOrCreateAssociatedTokenAccount(connection, wallet.payer, NATIVE_MINT, wallet.publicKey);

    // WSol Token Account for delegate PDA
    await getOrCreateAssociatedTokenAccount(connection, wallet.payer, NATIVE_MINT, delegatePDA, true);
  });

  it('Create Mint Account with Transfer Hook Extension', async () => {
    const extensions = [ExtensionType.TransferHook];
    const mintLen = getMintLen(extensions);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

    const transaction = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports: lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mint.publicKey,
        wallet.publicKey,
        program.programId, // Transfer Hook Program ID
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMintInstruction(mint.publicKey, decimals, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
    );

    const txSig = await sendAndConfirmTransaction(provider.connection, transaction, [wallet.payer, mint]);
    console.log(`Transaction Signature: ${txSig}`);
  });

  // Create the two token accounts for the transfer-hook enabled mint
  // Fund the sender token account with 100 tokens
  it('Create Token Accounts and Mint Tokens', async () => {
    // 100 tokens
    const amount = 100 * 10 ** decimals;

    const transaction = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        sourceTokenAccount,
        wallet.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        destinationTokenAccount,
        recipient.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createMintToInstruction(mint.publicKey, sourceTokenAccount, wallet.publicKey, amount, [], TOKEN_2022_PROGRAM_ID),
    );

    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });

    console.log(`Transaction Signature: ${txSig}`);
  });

  // Account to store extra accounts required by the transfer hook instruction
  it('Create ExtraAccountMetaList Account', async () => {
    const initializeExtraAccountMetaListInstruction = await program.methods
      .initializeExtraAccountMetaList()
      .accounts({
        payer: wallet.publicKey,
        mint: mint.publicKey,
      })
      .instruction();

    const transaction = new Transaction().add(initializeExtraAccountMetaListInstruction);

    const txSig = await sendAndConfirmTransaction(provider.connection, transaction, [wallet.payer], { skipPreflight: true, commitment: 'confirmed' });
    console.log('Transaction Signature:', txSig);
  });

  it('Transfer Hook with Extra Account Meta', async () => {
    // 1 tokens
    const amount = 1 * 10 ** decimals;
    const bigIntAmount = BigInt(amount);

    // Instruction for sender to fund their WSol token account
    const solTransferInstruction = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: senderWSolTokenAccount,
      lamports: amount,
    });

    // Approve delegate PDA to transfer WSol tokens from sender WSol token account
    const approveInstruction = createApproveInstruction(senderWSolTokenAccount, delegatePDA, wallet.publicKey, amount, [], TOKEN_PROGRAM_ID);

    // Sync sender WSol token account
    const syncWrappedSolInstruction = createSyncNativeInstruction(senderWSolTokenAccount);

    const mintInfo = await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const transferHook = getTransferHook(mintInfo);
    if (transferHook != null) {
      console.log(`Transfer hook program found: ${JSON.stringify(transferHook, null, 2)}`);
    }

    const extraAccountsAccount = getExtraAccountMetaAddress(mint.publicKey, transferHook.programId);
    const extraAccountsInfo = await connection.getAccountInfo(extraAccountsAccount, 'confirmed');
    const extraAccountMetas = getExtraAccountMetas(extraAccountsInfo);

    // for (const extraAccountMeta of extraAccountMetas) {
    //   console.log(`Extra account meta: ${JSON.stringify(extraAccountMeta, null, 2)}`);
    // }

    // Standard token transfer instruction
    const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
      connection,
      sourceTokenAccount,
      mint.publicKey,
      destinationTokenAccount,
      wallet.publicKey,
      bigIntAmount,
      decimals,
      [],
      'confirmed',
      TOKEN_2022_PROGRAM_ID,
    );

    // console.log('Pushed keys:', JSON.stringify(transferInstruction.keys, null, 2));

    const transaction = new Transaction().add(solTransferInstruction, syncWrappedSolInstruction, approveInstruction, transferInstruction);

    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
    console.log('Transfer Signature:', txSig);

    const tokenAccount = await getAccount(connection, delegateWSolTokenAccount);

    expect(Number(tokenAccount.amount)).equal(amount);
  });

  it('Withdraw funds from delegate PDA', async () => {
    // Amount to withdraw (assuming it's the same as the amount transferred in the previous test)
    const amount = 1 * 10 ** decimals;
    const bigIntAmount = BigInt(amount);

    // Get the initial balance of the recipient's wSOL account
    const initialRecipientBalance = (await getAccount(connection, senderWSolTokenAccount)).amount;

    // Create the withdraw instruction
    const withdrawInstruction = await program.methods
      .withdrawDelegateFunds(new anchor.BN(amount))
      .accounts({
        recipient: wallet.publicKey,
        delegate: delegatePDA,
        delegateWsolTokenAccount: delegateWSolTokenAccount,
        recipientWsolTokenAccount: senderWSolTokenAccount,
        wsolMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // Create and send the transaction
    const transaction = new Transaction().add(withdrawInstruction);
    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
    console.log('Withdraw Transaction Signature:', txSig);

    // Verify the withdrawal
    const finalDelegateBalance = (await getAccount(connection, delegateWSolTokenAccount)).amount;
    const finalRecipientBalance = (await getAccount(connection, senderWSolTokenAccount)).amount;

    expect(Number(finalDelegateBalance)).to.equal(0);
    expect(Number(finalRecipientBalance)).to.equal(Number(initialRecipientBalance) + amount);
  });

  it("check autoroty pda", async () => {
    const [authorityPda, authorityBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('authority')],
      program.programId
    );

    const authorityPdaAccount = await program.account.authorityPda.fetch(authorityPda);

    expect(authorityPdaAccount.authority.toBase58()).to.equal(wallet.publicKey.toBase58());




  })


  it('Transfer Hook with Extra Account Meta2', async () => {
    // 1 tokens
    const amount = 1 * 10 ** decimals;
    const bigIntAmount = BigInt(amount);

    // Instruction for sender to fund their WSol token account
    const solTransferInstruction = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: senderWSolTokenAccount,
      lamports: amount,
    });

    // Approve delegate PDA to transfer WSol tokens from sender WSol token account
    const approveInstruction = createApproveInstruction(senderWSolTokenAccount, delegatePDA, wallet.publicKey, amount, [], TOKEN_PROGRAM_ID);

    // Sync sender WSol token account
    const syncWrappedSolInstruction = createSyncNativeInstruction(senderWSolTokenAccount);

    const mintInfo = await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const transferHook = getTransferHook(mintInfo);
    if (transferHook != null) {
      console.log(`Transfer hook program found: ${JSON.stringify(transferHook, null, 2)}`);
    }

    const extraAccountsAccount = getExtraAccountMetaAddress(mint.publicKey, transferHook.programId);
    const extraAccountsInfo = await connection.getAccountInfo(extraAccountsAccount, 'confirmed');
    const extraAccountMetas = getExtraAccountMetas(extraAccountsInfo);

    // for (const extraAccountMeta of extraAccountMetas) {
    //   console.log(`Extra account meta: ${JSON.stringify(extraAccountMeta, null, 2)}`);
    // }

    // Standard token transfer instruction
    const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
      connection,
      sourceTokenAccount,
      mint.publicKey,
      destinationTokenAccount,
      wallet.publicKey,
      bigIntAmount,
      decimals,
      [],
      'confirmed',
      TOKEN_2022_PROGRAM_ID,
    );

    // console.log('Pushed keys:', JSON.stringify(transferInstruction.keys, null, 2));

    const transaction = new Transaction().add(solTransferInstruction, syncWrappedSolInstruction, approveInstruction, transferInstruction);

    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
    console.log('Transfer Signature:', txSig);

    const tokenAccount = await getAccount(connection, delegateWSolTokenAccount);

    expect(Number(tokenAccount.amount)).equal(amount);
  });


  

  it('Withdraw funds from delegate PDA with an unauthorized wallet', async () => {
    // Create a new wallet (unauthorized wallet)
    const unauthorizedWallet = Keypair.generate();

    // Amount to withdraw (assuming it's the same as the amount transferred in the previous test)
    const amount = 1 * 10 ** decimals;
    const bigIntAmount = BigInt(amount);

    // Airdrop some SOL to the unauthorized wallet
    const airdropSignature = await connection.requestAirdrop(
        unauthorizedWallet.publicKey,
        2 * LAMPORTS_PER_SOL // Airdrop 2 SOL
    );
    await connection.confirmTransaction(airdropSignature);

    // Create a wSOL account for the unauthorized wallet
    const unauthorizedWalletWSolTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        unauthorizedWallet,
        NATIVE_MINT,
        unauthorizedWallet.publicKey
    );

    // Create the withdraw instruction
    const withdrawInstruction = await program.methods
        .withdrawDelegateFunds(new anchor.BN(amount))
        .accounts({
            recipient: unauthorizedWallet.publicKey,
            delegate: delegatePDA,
            delegateWsolTokenAccount: delegateWSolTokenAccount,
            recipientWsolTokenAccount: unauthorizedWalletWSolTokenAccount.address,
            wsolMint: NATIVE_MINT,
            tokenProgram: TOKEN_PROGRAM_ID,        })
        .instruction();

    // Create and send the transaction
    const transaction = new Transaction().add(withdrawInstruction);
    let txError = null;

    try {
        await sendAndConfirmTransaction(
            connection,
            transaction,
            [unauthorizedWallet],
            { skipPreflight: true }
        );
    } catch (err) {
        txError = err;
    }

    // Verify that the transaction was rejected with the correct error
    expect(txError).to.not.be.null;
    // if (txError) {
    //     const errorCode = txError.logs.find(log => log.includes('Error Code:'));
    //     expect(errorCode).to.include('Unauthorized');
    // }
});

});