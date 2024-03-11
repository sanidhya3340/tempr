import React, { useEffect, useMemo, useRef } from "react";
import {
  View,
  TouchableOpacity,
  Image,
  StyleSheet,
  Alert,
  ActivityIndicator,
  BackHandler,
  Vibration,
  NativeModules,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import RazorpayCheckout from "react-native-razorpay";
import CodePush from "react-native-code-push";
import { KEY } from "../../../../Settings";
import { Text } from "components/core";
import { icons } from "assets/images";
import UserWallet from "../../../../network/WalletApis";
import OrderApis from "../../../../network/v3/OrderApis";
import UtilityApis from "../../../../network/v3/MiscApis";
import DistributorApis from "../../../../network/v3/DistributorApis";
import Apis from "../../../../network/OrderApis";
import { connect } from "react-redux";
import baseConfig, { Config } from "src/Settings";
import { clearCart, sucessResetCart } from "redux-store/actions";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { clearCheckpoints, setCheckpointState } from "manager/config/AppStateManager";
import OrderRetry, { ActionStage, shouldShowRetryUI } from "components/custom/OrderRetry";
import { Feature } from "../../../PermissionManager";
import { User } from "../../../../UserManager";
import { handleError } from "../../../../utils/Helper";
import { colors, v1 } from "../../../../assets/Theme";
import { CT_Sell } from "../../../../utils/tracking/CleverTap";
import { removeData } from "utils/storage";
import withPageTranslator, { useAppTranslation } from "../../../../i18n/PageTranslator";
import Timer from "./_components/Timer";
import PaymentOption from "./_components/PaymentOption";
import { basicModification } from "../../../WorkflowWrapper";
import InputToolbar from "./_components/InputToolbar";
import logger from "../../../../spro-native/logger";

const checkpoints = {
  transferCalled: 1,
};

const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
});

const DURATION = {
  SHORT: 3,
  LONG: 8,
};

const { UIManager } = NativeModules;
UIManager.setLayoutAnimationEnabledExperimental &&
  UIManager.setLayoutAnimationEnabledExperimental(true);

export const PAYMENT_MODE = {
  CP_WALLET: "cp wallet",
  SELLER_WALLET: "seller wallet",
  LINK: "ecod",
};

function Payment({ showLoader, ...props }) {
  const cartTotalAmount = props.cart?.amount;
  const { userInfo } = props.appInfo;
  const canSeeWalletBalance = User.checkPermission(Feature.SeeWalletBalance);
  const canPayFromWallet =
    User.checkPermission(Feature.CanPayFromWallet) && userInfo.channel_name !== "onsitego-scouts";
  const canPayFromCPWallet = User.checkPermission(Feature.CanPayFromCPWallet);
  const canPayUsingLink = User.checkPermission(Feature.CanPayUsingLink);
  const hasRechargePermission = User.checkPermission(Feature.RechargeOwnWallet);

  const timerRef = useRef(null);
  const t = useAppTranslation();
  const navigation = useNavigation();

  const [paymentMethod, setPaymentMethod] = React.useState("");
  const [checkoutData, setCheckoutData] = React.useState({});

  const [inputText, setInputText] = React.useState(String(Math.ceil(cartTotalAmount)));
  const [errorText, setErrorText] = React.useState(null);
  const [apiInProgress, setAPIInProgress] = React.useState(canPayFromWallet);
  const [rechargeInProgress, setRechargeInProgress] = React.useState(false);
  const [walletRechargePaymentDone, setWalletRechargePaymentDone] = React.useState(false);
  const [payButtonDisabled, disablePayButton] = React.useState(true);

  const [errorTextCP, setErrorTextCP] = React.useState(null);
  const [inputTextCP, setInputTextCP] = React.useState(String(Math.ceil(cartTotalAmount)));
  const [cpApiInProgress, setCPAPIInProgress] = React.useState(canPayFromCPWallet);
  const [cprInProgress, setCPRInProgress] = React.useState(false);
  const [cprRaised, setCPRRaised] = React.useState(false);
  const [cpPayDisabled, setCpPayDisabled] = React.useState(false);

  const [Duration, setDuration] = React.useState(DURATION.SHORT);
  const [cartData, setCartData] = React.useState(props.cart);
  const [linkCreated, setLinkCreated] = React.useState(false);
  const [orderCreated, setOrderCreated] = React.useState(null);
  const isFocused = useIsFocused();
  const [creditWalletInfo, setCreditWalletInfo] = React.useState({});
  const [walletBalance, setWalletBalance] = React.useState(0);
  const [disableConfirm, setDisableConfirm] = React.useState(false);

  const prevState = props.appInfo.checkpointState;
  let params = {
    ...props.route.params,
  };
  if (prevState.checkpoint) {
    params = {
      ...prevState.params,
    };
  }
  const [retryDetails, setRetryDetails] = React.useState({
    actionStage: ActionStage.DEFAULT,
    orderInitiated: false,
    resumedPaymentData: {},
    resumedTransferData: {},
    trialsCount: 0,
    backTrialCount: 0,
    ...params.retryDetails,
  });

  const loadWalletError = useMemo(
    () => ({
      error: {
        message: t("errors.loadwallet"),
      },
    }),
    [t]
  );
  const loadWalletError2 = useMemo(
    () => ({
      error: {
        message: t("errors.loadwallet2"),
      },
    }),
    [t]
  );
  // const linkError = {
  //   error: {
  //     message: t("errors.linkerror"),
  //   },
  // };

  useEffect(() => {
    let retry =
      params.retryDetails &&
      (props.route.params?.from == true ? params.retryDetails : retryDetails);
    let show = shouldShowRetryUI(retry && retry.actionStage);
    if (retry && retry.orderInitiated && !show && props.route.name == "Payment") {
      timerRef.current = setTimeout(() => {
        cleanup();
        clearCheckpoints().then(() => {
          navigation.navigate("Orders", { from: true });
        });
      }, 85 * 1000);
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [params.retryDetails, navigation, props.route.name, props.route.params?.from, retryDetails]);

  useEffect(() => {
    if (orderCreated) {
      resumeOrderPlacement();
    }
  }, [orderCreated]);

  useEffect(() => {
    const backAction = () => {
      if (!props.isLoading) {
        if (
          (props.appInfo.checkpointState.params?.retryDetails &&
            !props.appInfo.checkpointState.params?.retryDetails?.orderInitiated) ||
          Object.keys(props.appInfo.checkpointState.params).length == 0
        ) {
          navigation.pop();
        }
      }
      return true;
    };
    const backHandler = BackHandler.addEventListener("hardwareBackPress", backAction);
    return () => backHandler.remove();
  }, [props.isLoading, props.appInfo.checkpointState.params?.retryDetails]);

  useEffect(() => {
    if (retryDetails.actionStage == ActionStage.CREATED_WALLET_PAYMENT_REQUEST) {
      schedulePollRequest(
        retryDetails.resumedPaymentData.requestData,
        retryDetails.resumedPaymentData.data
      );
    }
  }, []);

  useEffect(() => {
    let skus = [];
    props.cart?.items.map((item) => {
      skus.push(item.sku);
    });
    setCheckoutData({
      ...props.cart,
      application: "salespro",
      client: "salespro",
      data: {
        token_id: props.cart?.token_id,
        name: props.cart?.name || "",
        address: props.cart?.address || "",
        email: props.cart?.email || "",
        phone: props.cart?.phone || "",
        pincode: props.cart?.pincode || null,
        retailer_phone: userInfo.phone,
        skus: skus,
        brand: null,
      },
    });
  }, []);

  /**
   * This effect will select a payment mode on mount
   * also it will fetch balance only if user has permission to that payment mode
   * */
  useEffect(() => {
    if (isFocused) {
      const initDefaultSelection = async () => {
        let sellerWalletBalance = 0;
        let creditWallet = { balance: 0 };
        if (canPayFromWallet) {
          sellerWalletBalance = await fetchBalance();
        }
        if (canPayFromCPWallet) {
          creditWallet = await fetchCPWalletBalance();
        }
        if (params.selectedPaymentMethod) {
          setPaymentMethod(params.selectedPaymentMethod);
        } else {
          // P1
          if (canPayFromWallet) {
            if (sellerWalletBalance >= cartTotalAmount) {
              setPaymentMethod(PAYMENT_MODE.SELLER_WALLET);
              return;
            } else {
              let balStr = String(Math.ceil(cartTotalAmount - sellerWalletBalance)).trim();
              setInputText(balStr);
              setErrorText(
                t("walletpopup.errortext", {
                  balance: balStr,
                })
              );
            }
          }
          // P2
          if (canPayFromCPWallet) {
            if (creditWallet.balance >= cartTotalAmount) {
              setPaymentMethod(PAYMENT_MODE.CP_WALLET);
              return;
            } else {
              let balStr = String(Math.ceil(cartTotalAmount - creditWallet.balance)).trim();
              setInputTextCP(balStr);
              setErrorTextCP(
                t("walletpopup.errortext", {
                  balance: balStr,
                })
              );
            }
          }
          // P3
          if (canPayUsingLink) {
            setPaymentMethod(PAYMENT_MODE.LINK);
          }
        }
      };
      initDefaultSelection();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isFocused,
    cartTotalAmount,
    canPayFromCPWallet,
    canPayUsingLink,
    canPayFromWallet,
    params.selectedPaymentMethod,
  ]);

  // CT Event on Mode selection
  useEffect(() => {
    let wallet_amount = 0;
    if (paymentMethod == PAYMENT_MODE.CP_WALLET && canPayFromCPWallet) {
      fetchCPWalletBalance().then((walletInfo) => {
        wallet_amount = walletInfo.balance;
        CT_Sell.placeOrderPaymentOptionSelected(paymentMethod, {
          amount: cartTotalAmount,
          phone: props.cart?.phone,
          wallet_amount: wallet_amount,
        });
      });
    } else if (paymentMethod == PAYMENT_MODE.SELLER_WALLET && canPayFromWallet) {
      setAPIInProgress(true);
      fetchBalance().then((balance) => {
        CT_Sell.placeOrderPaymentOptionSelected(paymentMethod, {
          amount: cartTotalAmount,
          phone: props.cart?.phone,
          wallet_amount: balance,
        });
      });
    } else if (paymentMethod == PAYMENT_MODE.LINK && canPayUsingLink) {
      CT_Sell.placeOrderPaymentOptionSelected(paymentMethod, {
        amount: cartTotalAmount,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    paymentMethod,
    cartTotalAmount,
    loadWalletError,
    canPayFromCPWallet,
    canPayFromWallet,
    canPayUsingLink,
    props.cart?.phone,
  ]);

  // Effect for Process : CP Wallet
  useEffect(() => {
    if (!isFocused) {
      return;
    }
    if (paymentMethod == PAYMENT_MODE.CP_WALLET && cartTotalAmount > creditWalletInfo.balance) {
      setCpPayDisabled(true);
      if (cprRaised) {
        return;
      }
      let balStr = String(Math.ceil(cartTotalAmount - creditWalletInfo.balance)).trim();
      setInputTextCP(balStr);
      setErrorTextCP(
        t("walletpopup.errortext", {
          balance: balStr,
        })
      );
      if (!creditWalletInfo.is_own_cp_wallet) {
        props.publishMessage({
          info: {
            title: t("errors.insufficientbal"),
            message: t("errors.insufficientbalmsg", {
              distributor_name: userInfo.distributor_name,
            }),
            cancellable: true,
            style: { backgroundColor: colors.secondary },
          },
        });
        return;
      }
      //  else {
      // props.publishMessage({
      //   info: {
      //     title: t("errors.insufficientbal"),
      //     message: t("errors.insufficientbalmsg2"),
      //     cancellable: true,
      //     style: { backgroundColor: colors.secondary },
      //   },
      // });
      // }
      return;
    } else if (cartTotalAmount <= creditWalletInfo.balance) {
      setErrorTextCP(null);
    }

    setCpPayDisabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isFocused,
    cprRaised,
    creditWalletInfo.balance,
    creditWalletInfo.is_own_cp_wallet,
    paymentMethod,
    cartTotalAmount,
    props,
    userInfo.distributor_name,
  ]);

  // Process: CP Wallet
  useEffect(() => {
    if (!cprInProgress) {
      setCPRRaised(false);
    }
  }, [cprInProgress]);

  // Process: Seller Wallet
  useEffect(() => {
    if (!rechargeInProgress) {
      setWalletRechargePaymentDone(false);
    }
  }, [rechargeInProgress]);

  const setCheckpoint = async (_retryDetails) => {
    setCheckpointState({
      screen: props.currentRouteName,
      checkpoint: checkpoints.transferCalled,
      params: {
        cartData: cartData,
        retryDetails: _retryDetails,
        selectedPaymentMethod: paymentMethod,
      },
    });
  };

  const fetchOrderHistory = (lastId, data) => {
    Apis.getOrderHistory(
      lastId,
      "pagination",
      {},
      (response) => {
        if (response.hasOwnProperty("transactions")) {
          let orderFound = response.transactions.find(
            (o) =>
              (paymentMethod == PAYMENT_MODE.LINK &&
                data?.order_id == o.order_id &&
                o.status == "PAYMENT_PENDING" &&
                o?.additional_details?.short_url) ||
              (data?.order_id == o.order_id && o.status == "PAYMENT_SUCCESS")
          );

          if (orderFound) {
            showLoader(false);
            setLinkCreated(true);
            setOrderCreated(true);
          } else {
            showLoader(false);
            setLinkCreated(false);
            setOrderCreated(false);
          }
        }
      },
      (error) => {
        handleError(error);
      }
    );
  };

  const cleanup = () => {
    props.sucessResetCart();
    removeData(KEY.CART_TOKEN);
    removeData(KEY.DISOUNT_DETAIL);
    clearCart();
    showLoader(false);
  };

  const resumeOrderPlacement = () => {
    /* Here take action which is based on ActionStage */
    const { resumedTransferData, resumedPaymentData, actionStage } =
      props.route.params?.from == true ? params.retryDetails : retryDetails;
    switch (actionStage) {
      case ActionStage.ERROR_CREATING_WALLET_PAYMENT_REQUEST:
        showLoader(true);
        transfer(resumedTransferData);
        break;
      case ActionStage.ERROR_CREATING_ORDER:
        showLoader(true);
        if (paymentMethod == PAYMENT_MODE.SELLER_WALLET) {
          walletCheckout(resumedPaymentData.data);
        } else {
          fetchOrderHistory(null, resumedPaymentData.data);
          if (orderCreated != null && orderCreated) {
            successMessage(resumedPaymentData?.transfer_amount);
          } else {
            cpCheckout(resumedPaymentData.data);
          }
        }
        break;
      case ActionStage.ERROR_POLLING_REQUEST_STATUS:
        showLoader(true);
        schedulePollRequest(resumedPaymentData.requestData, resumedPaymentData.data);
        break;
      case ActionStage.CREATING_ORDER_FAILED:
        showLoader(true);
        fetchOrderHistory(null, resumedTransferData);
        if (orderCreated != null && orderCreated) {
          successMessage(resumedTransferData?.transfer_amount);
        } else {
          transfer(resumedTransferData);
        }
        break;
      case ActionStage.CREATING_ORDER:
        showLoader(true);
        if (props.route.params?.from == true) {
          Apis.getTransactionHistory(
            null,
            (txn) => {
              let index = 0;
              txn.payments.map((request) => {
                if (
                  retryDetails.resumedPaymentData &&
                  retryDetails.resumedPaymentData?.requestData?.order_id == request.order_id
                ) {
                  index = txn.payments.indexOf(request);
                }
              });
              if (txn.payments[index].status == "success") {
                successMessage(resumedPaymentData && resumedPaymentData?.data?.amount);
                return;
              } else if (txn.payments[index].status == "failed") {
                handleError(loadWalletError2);
              }
              cleanup();
              clearCheckpoints();
              navigation.navigate("Orders", { from: true });
            },
            (error) => {
              handleError(error);
            }
          );
        }
        break;
      case ActionStage.CREATING_ORDER_SUCCESS:
        showLoader(true);
        if (props.route.params?.from == true) {
          Apis.getTransactionHistory(
            null,
            (txn) => {
              let index = 0;
              txn.payments.map((request) => {
                if (
                  retryDetails.resumedPaymentData &&
                  retryDetails.resumedPaymentData?.requestData?.order_id == request.order_id
                ) {
                  index = txn.payments.indexOf(request);
                }
              });
              if (txn.payments[index].status == "success") {
                successMessage(resumedPaymentData && resumedPaymentData?.data?.amount);
                return;
              } else if (txn.payments[index].status == "failed") {
                handleError(loadWalletError2);
              }
              cleanup();
              clearCheckpoints();
              navigation.navigate("Orders", { from: true });
            },
            (error) => {
              handleError(error);
            }
          );
        }
        break;
      case ActionStage.ERROR_CREATING_ECOD_PAYMENT_REQUEST:
        showLoader(true);
        fetchOrderHistory(null, resumedPaymentData.data);
        if (linkCreated) {
          linkSuccess();
        } else {
          linkCreation(resumedPaymentData.data);
        }
        break;
      case ActionStage.ERROR_SENDING_ECOD_PAYMENT_LINK:
        showLoader(true);
        createECODOrder(resumedTransferData);
        break;
      case ActionStage.CREATED_WALLET_PAYMENT_REQUEST:
        showLoader(true);
        schedulePollRequest(resumedPaymentData.requestData, resumedPaymentData.data);
        break;
      case ActionStage.WALLET_STATUS_PENDING:
        showLoader(true);
        schedulePollRequest(resumedPaymentData.requestData, resumedPaymentData.data);
        break;
    }
  };

  const checkRequestStatus = (requestData, payment_data) => {
    UserWallet.getRequestStatus(
      requestData,
      (response) => {
        if (response.retailer_payment_details[0].status == "pending") {
          setChecks({
            ...retryDetails,
            ...params.retryDetails,
            actionStage: ActionStage.WALLET_STATUS_PENDING,
            resumedPaymentData: {
              requestData: requestData,
              data: payment_data,
            },
          });

          schedulePollRequest(requestData, payment_data);
        } else if (response.retailer_payment_details[0].status == "failed") {
          setChecks({
            ...retryDetails,
            ...params.retryDetails,
            actionStage: ActionStage.WALLET_STATUS_FAILED,
            resumedPaymentData: {
              requestData: requestData,
              data: payment_data,
            },
          });

          handleError(loadWalletError2);
          cleanup();
          clearCheckpoints();
          navigation.navigate("Orders", { from: true });
          fetchBalance();
          CT_Sell.paymentFailed({
            mode_of_payment: paymentMethod,
            amount: cartTotalAmount,
            payment_source: response.retailer_payment_details[0].gateway,
            plan_price: cartTotalAmount,
            wallet_amount: walletBalance,
            txn_id: response.retailer_payment_details[0].payment_id,
            error: response.retailer_payment_details[0].status,
          });
        } else if (response.retailer_payment_details[0].status == "success") {
          setChecks({
            ...retryDetails,
            ...params.retryDetails,
            actionStage: ActionStage.WALLET_STATUS_SUCCESS,
            resumedPaymentData: {
              requestData: requestData,
              data: payment_data,
            },
          });

          showLoader(false);
          CT_Sell.paymentSuccess({
            mode_of_payment: paymentMethod,
            amount: cartTotalAmount,
            payment_source: response.retailer_payment_details[0].gateway,
            plan_price: cartTotalAmount,
            wallet_amount: walletBalance,
            txn_id: response.retailer_payment_details[0].payment_id,
          });
          createECODOrder({
            _d: payment_data,
            order_id: response.order_id,
            response: response,
            cartData: props.cart,
            payment_status: "SUCCESS",
            payment_data: payment_data,
          });
        }
      },
      (error) => {
        /* Add retry mechanism here */
        handleError(error);
        setChecks({
          ...retryDetails,
          ...params.retryDetails,
          orderInitiated: true,
          actionStage: ActionStage.ERROR_POLLING_REQUEST_STATUS,
          resumedPaymentData: {
            requestData: requestData,
            data: payment_data,
          },
        });
      }
    );
  };

  const schedulePollRequest = (requestData, payment_data) => {
    setRetryDetails({
      ...retryDetails,
      ...params.retryDetails,
      actionStage: ActionStage.POLLING_REQUEST_STATUS,
      resumedPaymentData: {
        requestData: requestData,
        data: payment_data,
      },
    });
    let timeoutId = setTimeout(() => {
      checkRequestStatus(requestData, payment_data);
    }, 3 * 1000);
  };

  // Process : Seller Wallet
  const fetchBalance = async () => {
    return await UserWallet.getBalance()
      .then((response) => {
        let balance = response.balance / 100; // amount is returned in paisa by rzp
        let enoughBalance = balance >= cartTotalAmount;

        if (walletRechargePaymentDone) {
          setDuration(DURATION.SHORT);
          setRechargeInProgress(true);
        } else {
          setDuration(DURATION.LONG);
          setAPIInProgress(false);
        }
        setWalletBalance(balance);

        if (enoughBalance) {
          walletRechargePaymentDone && setRechargeInProgress(false);
          disablePayButton(false);
        } else {
          disablePayButton(true);
        }
        setAPIInProgress(false);
        return balance;
      })
      .catch(() => {
        disablePayButton(true);
        setAPIInProgress(false);
        handleError(loadWalletError);
      });
  };

  // Process : CP Wallet
  const fetchCPWalletBalance = async () => {
    setCPAPIInProgress(true);
    return await UtilityApis.fetchCPBalance(userInfo.retailer_token)
      .then((response) => {
        let balance = response.balance;
        let enoughBalance = balance >= cartTotalAmount;
        if (cprRaised) {
          setDuration(DURATION.SHORT);
        } else {
          setDuration(DURATION.LONG);
        }
        // order of call brlow function matters,
        // balance needs to be published before setCPRInProgress(false)
        // else popup will be shown of low balance
        setCreditWalletInfo(response);

        if (enoughBalance) {
          setCpPayDisabled(false);
          cprRaised && setCPRInProgress(false);
        } else {
          setCpPayDisabled(true);
        }
        setCPAPIInProgress(false);
        return response;
      })
      .catch((error) => {
        handleError(error);
      });
  };

  const successMessage = (amount) => {
    props.publishMessage({
      success: {
        title: t("paysuccess_title"),
        message: t("paysuccess_msg", {
          amount: cartTotalAmount || amount,
        }),
      },
    });
    setTimeout(() => {
      cleanup();
      clearCheckpoints().then(() => {
        const SEC_TO_MS = 1000;
        Vibration.vibrate(0.5 * SEC_TO_MS);
        navigation.navigate("Orders", { from: true });
      });
    }, 2000);
  };

  const transfer = (data) => {
    if (paymentMethod == PAYMENT_MODE.CP_WALLET) {
      let newData = {
        application: "salespro",
        gateway: data.gateway,
        data: {
          ...data,
          token_id: data.token_id,
          amount: data?.transfer_amount,
        },
      };
      showLoader(true);
      OrderApis.success(
        newData,
        (response) => {
          if (response.retailer_payment_transfer_ids) {
            setChecks({
              ...retryDetails,
              ...params.retryDetails,
              actionStage: ActionStage.CREATING_ORDER_SUCCESS,
              orderInitiated: true,
              resumedPaymentData: {
                data: data,
              },
            });

            CT_Sell.orderSuccess({
              order_amount: cartTotalAmount,
              wallet_amount: creditWalletInfo.balance,
              retailer_code: userInfo.dealer_id,
              mode_of_payment: paymentMethod,
              payment_source: newData.data?.gateway,
              order_id: data.order_id,
              customer_phone: props.cart?.phone,
              customer_name: props.cart?.name,
              customer_email: props.cart?.email,
              plan_price: cartTotalAmount,
            });
            successMessage(data?.transfer_amount);
          } else {
            fetchCPWalletBalance();
            const { resumedTransferData, actionStage } = params.retryDetails
              ? params.retryDetails
              : retryDetails;
            if (orderCreated == null) {
              fetchOrderHistory(null, resumedTransferData);
            } else {
              handleError({ message: t("errors.tryagain") });
            }
          }
        },
        (e) => {
          fetchCPWalletBalance();
          handleError(e);
          CT_Sell.orderFailure({
            order_amount: cartTotalAmount,
            wallet_amount: creditWalletInfo.balance,
            retailer_code: userInfo.dealer_id,
            mode_of_payment: paymentMethod,
            payment_source: newData.data?.gateway,
            order_id: data.order_id,
            customer_phone: props.cart?.phone,
            customer_name: props.cart?.name,
            customer_email: props.cart?.email,
            plan_price: cartTotalAmount,
            error: e.message,
          });
          setChecks({
            ...retryDetails,
            ...params.retryDetails,
            orderInitiated: true,
            actionStage: ActionStage.CREATING_ORDER_FAILED,
            resumedTransferData: data,
          });
        }
      );
    } else {
      setRetryDetails({
        ...retryDetails,
        ...params.retryDetails,
        actionStage: ActionStage.CREATING_WALLET_PAYMENT_REQUEST,
        resumedTransferData: {},
        resumedPaymentData: {},
      });
      showLoader(true);
      UserWallet.postPaymentRequest(
        data,
        (response) => {
          let requestData = {
            registered_phone: userInfo.outlet_phone,
            retailer_payment_ids: response.retailer_payment_transfer_ids,
          };
          setChecks({
            ...retryDetails,
            ...params.retryDetails,
            orderInitiated: true,
            actionStage: ActionStage.CREATED_WALLET_PAYMENT_REQUEST,
            resumedPaymentData: {
              requestData: requestData,
              data: data,
            },
          });

          schedulePollRequest(requestData, data);
        },
        (e) => {
          showLoader(false);
          if (e.error != null) {
            if (e.error?.code === "WAT_PENDING_TXN_IN_QUEUE") {
              Alert.alert(
                "Alert",
                e.error?.details,
                [
                  {
                    text: "OK",
                    onPress: () => {},
                  },
                ],
                { cancelable: false }
              );
            } else {
              handleError({ message: e.error?.details }, false);
            }
          } else {
            handleError(e);
          }
          setChecks({
            ...retryDetails,
            ...params.retryDetails,
            orderInitiated: true,
            actionStage: ActionStage.ERROR_CREATING_WALLET_PAYMENT_REQUEST,
            resumedTransferData: data,
            trialsCount: retryDetails.trialsCount + 1,
          });
        }
      );
    }
  };

  /**
   * this method will be used to pay using seller wallet
   * @param {any} _cartData : final cart object
   */
  const payWallet = (_cartData) => {
    let data = {};

    let walletId = userInfo.razorpay_wallet_id;
    if (userInfo.parent_sw_enabled) {
      walletId = userInfo.razorpay_super_wallet_id;
    }
    data = {
      gateway: "razorpay",
      type: "order_create_transfer",
      transfer_type: "OCT",
      from_wallet: walletId,
      notes: {
        deducted_from: walletId,
        order_id: _cartData.order_id,
      },
    };

    data.retailer_id = userInfo.outlet_id + "";
    data.order_id = _cartData.order_id + "";
    data.registered_phone = userInfo.outlet_phone + "";
    data.transfer_amount = _cartData.amount + "";
    data.token_id = _cartData.token_id + "";
    data.txnid = _cartData.txnid + "";
    transfer(data);
  };

  /**
   * this method will be used to pay using credit
   * @param {any} _cartData : final cart object
   */
  const payFromCredit = (_cartData) => {
    let data = {};
    let cpWalletId = userInfo.credit_point_wallet_id;
    if (userInfo.parent_credit_sw_enabled) {
      cpWalletId = userInfo.parent_credit_wallet_id;
    }
    data = {
      gateway: "onsitego",
      type: "order_credit_point_transfer",
      transfer_type: "OCPT",
      from_wallet: cpWalletId,
      notes: {
        deducted_from: cpWalletId,
        order_id: _cartData.order_id,
      },
    };

    data.retailer_id = userInfo.outlet_id + "";
    data.order_id = _cartData.order_id + "";
    data.registered_phone = userInfo.outlet_phone + "";
    data.transfer_amount = _cartData.amount + "";
    data.token_id = _cartData.token_id + "";
    data.txnid = _cartData.txnid + "";
    transfer(data);
  };

  const walletCheckoutSuccess = (data, response) => {
    let _cartData = { ...props.cart };
    setCheckoutData({ ...data, order_id: response.order_id + "" });
    _cartData = {
      ...props.cart,
      order_id: response.order_id,
      token_id: response.order_token_id,
    };
    setCartData(_cartData);
    payWallet(_cartData);
  };

  const walletCheckout = (data) => {
    clearCheckpoints().then(() => {
      OrderApis.cartOrderCheckout(
        data,
        (response) => {
          if (response.order_id) {
            setDisableConfirm(true);
            setChecks({
              ...retryDetails,
              ...params.retryDetails,
              actionStage: ActionStage.CREATING_ORDER_SUCCESS,
              orderInitiated: true,
              resumedPaymentData: {
                data: data,
                requestData: response,
              },
            });

            walletCheckoutSuccess(data, response);
          } else {
            setChecks({
              ...retryDetails,
              ...params.retryDetails,
              orderInitiated: false,
              actionStage: ActionStage.ERROR_CREATING_ORDER,
              resumedPaymentData: {
                data: data,
              },
            });

            setDisableConfirm(false);
            showLoader(false);
            handleError(response);
          }
        },
        (e) => {
          setChecks({
            ...retryDetails,
            ...params.retryDetails,
            orderInitiated: true,
            actionStage: ActionStage.ERROR_CREATING_ORDER,
            resumedPaymentData: {
              data: data,
            },
          });

          setDisableConfirm(false);
          showLoader(false);
          handleError(e, false);
        }
      );
    });
  };

  const handlePaymentWallet = () => {
    fetchBalance();
    setPaymentMethod(PAYMENT_MODE.SELLER_WALLET);
    if (walletBalance >= cartTotalAmount) {
      let data = checkoutData;
      data.gateway = "razorpay";
      data.data.additional_details = {
        app_version: Config.getDisplayVersion(),
        dealer_code: userInfo.dealer_id,
      };
      if (props.cart?.order_id) {
        data.data.order_id = props.cart?.order_id;
      }
      showLoader(true);
      props.publishConfirmation({
        confirmation: {
          title: t("walletpopup.title"),
          message: (
            <Text>
              {t("walletpopup.message", {
                symbol: "\u20B9",
                price: cartTotalAmount,
                source: t("walletpopup.wallet"),
              })}
              {`\n\n`}
              <Text bold>{t("walletpopup.confirmation")}</Text>
            </Text>
          ),
          buttons: {
            positiveButtonText: t("walletpopup.positive"),
            negativeButtonText: t("walletpopup.negative"),
            positiveButtonAction: () => {
              props.dismiss();
              showLoader(true);
              setTimeout(() => {
                if (!disableConfirm) {
                  CT_Sell.makePaymentWalletPayConfirm();
                  walletCheckout(data);
                }
              }, 500);
            },
            negativeButtonAction: () => {
              showLoader(false);
              props.dismiss();
              CT_Sell.makePaymentWalletPayCancel();
            },
          },
        },
      });
    } else {
      setInputText(String(Math.ceil(cartTotalAmount - walletBalance)).trim());
      setErrorText(
        t("walletpopup.errortext", { balance: String(Math.ceil(cartTotalAmount - walletBalance)) })
      );
    }
  };

  const cpCheckoutSuccess = (data, response) => {
    setDisableConfirm(true);
    setCheckoutData({
      ...data,
      order_id: response.order_id + "",
    });
    let _cartData = {
      ...props.cart,
      order_id: response.order_id,
      token_id: response.order_token_id,
      txnid: response.txnid,
    };
    setCartData(_cartData);
    payFromCredit(_cartData);
    CT_Sell.paymentSuccess({
      mode_of_payment: paymentMethod,
      amount: cartTotalAmount,
      payment_source: data.gateway,
      plan_price: cartTotalAmount,
      wallet_amount: creditWalletInfo.balance,
      txnid: response.payment_id,
    });
  };

  const cpCheckout = (data) => {
    CT_Sell.makePaymentWalletPayConfirm();
    showLoader(true);
    OrderApis.cartOrderCheckout(
      data,
      (response) => {
        if (response.order_id) {
          setChecks({
            ...retryDetails,
            ...params.retryDetails,
            orderInitiated: true,
            actionStage: ActionStage.CREATING_ORDER,
            resumedPaymentData: {
              data: data,
              requestData: response,
            },
          });
          cpCheckoutSuccess(data, response);
        } else {
          setChecks({
            ...retryDetails,
            ...params.retryDetails,
            orderInitiated: false,
            actionStage: ActionStage.ERROR_CREATING_ORDER,
            resumedPaymentData: { data: data },
          });

          showLoader(false);
          fetchCPWalletBalance();
          setDisableConfirm(false);
          handleError(response);
          CT_Sell.paymentFailed({
            mode_of_payment: paymentMethod,
            amount: cartTotalAmount,
            payment_source: data.gateway,
            plan_price: cartTotalAmount,
            wallet_amount: creditWalletInfo.balance,
            txnid: response.payment_id,
            error: response,
          });
        }
      },
      (e) => {
        setChecks({
          ...retryDetails,
          ...params.retryDetails,
          orderInitiated: true,
          actionStage: ActionStage.ERROR_CREATING_ORDER,
          resumedPaymentData: { data: data },
        });
        showLoader(false);
        setDisableConfirm(false);
        fetchCPWalletBalance();
        handleError(e, false);
        CT_Sell.paymentFailed({
          mode_of_payment: paymentMethod,
          amount: cartTotalAmount,
          payment_source: data.gateway,
          plan_price: cartTotalAmount,
          wallet_amount: creditWalletInfo.balance,
          error: e.message,
        });
      }
    );
  };

  const cpPaymentConfirmation = (data) => {
    let _cartData = { ...props.cart };
    props.publishConfirmation({
      confirmation: {
        title: "Alert!",
        message: (
          <Text>
            {t("walletpopup.message", {
              symbol: "\u20B9",
              price: cartTotalAmount,
              source: t("walletpopup.credit"),
            })}
            {`\n\n`}
            <Text bold>{t("walletpopup.confirmation")}</Text>
          </Text>
        ),
        buttons: {
          positiveButtonText: t("walletpopup.positive"),
          negativeButtonText: t("walletpopup.negative"),
          positiveButtonAction: async () => {
            if (!disableConfirm) {
              setDisableConfirm(true);
              props.dismiss();
              showLoader(true);
              await UtilityApis.fetchCPBalance(userInfo.retailer_token)
                .then((response) => {
                  setCreditWalletInfo(response);
                  setTimeout(() => {
                    if (cartTotalAmount <= response.balance) {
                      setCpPayDisabled(false);
                      cpCheckout(data, _cartData);
                    } else {
                      showLoader(false);
                      setCpPayDisabled(true);
                    }
                  }, 500);

                  setTimeout(async () => {
                    setDisableConfirm(false);
                  }, 3 * 1000);
                })
                .catch((error) => {
                  setDisableConfirm(false);
                  handleError(error);
                });
            }
          },
          negativeButtonAction: () => {
            showLoader(false);
            props.dismiss();
            CT_Sell.makePaymentWalletPayCancel();
          },
        },
      },
    });
  };

  const handlePaymentCPWallet = async () => {
    let _cartData = { ...props.cart };
    showLoader(true);
    await UtilityApis.fetchCPBalance(userInfo.retailer_token)
      .then((response) => {
        setCreditWalletInfo(response);
        let data = checkoutData;
        data.gateway = "onsitego";
        data.data.additional_details = {
          app_version: Config.getDisplayVersion(),
          dealer_code: userInfo.dealer_id,
        };
        if (props.cart?.order_id) {
          data.data.order_id = props.cart?.order_id;
        }
        if (cartTotalAmount <= response.balance) {
          setCpPayDisabled(false);
          cpPaymentConfirmation(data, _cartData, response);
        } else {
          setCpPayDisabled(true);
        }
        showLoader(false);
      })
      .catch((error) => {
        handleError(error);
      });
  };

  const linkSuccess = () => {
    cleanup();
    props.publishMessage({
      success: {
        title: t("linkpopup.successtitle"),
        message: t("linkpopup.successmsg"),
      },
    });
    clearCheckpoints().then(() => {
      const SEC_TO_MS = 1000;
      Vibration.vibrate(0.5 * SEC_TO_MS);
      navigation.navigate("Orders", { from: true });
    });
  };

  const setChecks = (data) => {
    // FIXME: need to simplify and remove duplicate values used for separate purpose
    setRetryDetails(data);
    setCheckpoint(data);
  };

  const createECODOrder = async (data) => {
    const { order_id, payment_status } = data;
    if (paymentMethod == PAYMENT_MODE.LINK) {
      // in case of payment link after generation need to share with user
      OrderApis.sendPaymentLink(
        {
          application: "salespro",
          data: {
            channel_name: userInfo.channel_name,
            token_id: data.token_id,
            retailer_phone: userInfo.phone,
            type: "multi_cart",
          },
          mode: PAYMENT_MODE.LINK,
          payment_status: payment_status,
          status: payment_status,
        },
        (response) => {
          if (response.status) {
            try {
              setChecks({
                ...retryDetails,
                ...params.retryDetails,
                actionStage: ActionStage.SENDING_ECOD_PAYMENT_LINK,
                orderInitiated: true,
                resumedTransferData: data,
              });
              linkSuccess();
            } catch (error) {
              setChecks({
                ...retryDetails,
                ...params.retryDetails,
                orderInitiated: true,
                actionStage: ActionStage.ERROR_SENDING_ECOD_PAYMENT_LINK,
                resumedTransferData: data,
              });
              logger.error(error);
            }
          } else {
            setChecks({
              ...retryDetails,
              ...params.retryDetails,
              orderInitiated: true,
              actionStage: ActionStage.ERROR_SENDING_ECOD_PAYMENT_LINK,
              resumedTransferData: data,
            });
            handleError(
              {
                error: {
                  message: t("errors.linksend"),
                },
              },
              false,
              true
            );
          }
        },
        (e) => {
          setChecks({
            ...retryDetails,
            ...params.retryDetails,
            orderInitiated: true,
            actionStage: ActionStage.ERROR_SENDING_ECOD_PAYMENT_LINK,
            resumedTransferData: data,
          });

          showLoader(false);
          handleError(e);
        }
      );
    } else if (payment_status == "SUCCESS") {
      // for other methods mark if payment was successfull
      showLoader(false);
      const { transfer_amount } = data;
      let amount = props.cart?.amount || transfer_amount;
      let evtData = {
        order_amount: amount,
        wallet_amount: walletBalance,
        retailer_code: userInfo.dealer_id,
        mode_of_payment: paymentMethod,
        payment_source: data.payment_data?.gateway,
        customer_phone: props.cart?.phone,
        customer_name: props.cart?.name,
        customer_email: props.cart?.email,
        plan_price: amount,
      };
      try {
        CT_Sell.orderSuccess({
          ...evtData,
          order_id: order_id,
        });
        successMessage(amount);
      } catch (error) {
        CT_Sell.orderFailure({
          ...evtData,
          error: error.message,
        });
        handleError(error);
      }
    }
  };

  // Process: Share Link
  const linkCreation = (orderData) => {
    const postData = {
      ...orderData,
      data: {
        ...orderData.data,
        additional_details: {
          app_version: Config.getDisplayVersion(),
          dealer_code: userInfo.dealer_id,
        },
      },
    };

    const linkCreationSuccess = (response) => {
      setChecks({
        ...retryDetails,
        ...params.retryDetails,
        orderInitiated: true,
        actionStage: ActionStage.CREATING_ECOD_PAYMENT_REQUEST,
        resumedPaymentData: {
          data: postData,
          requestData: response,
        },
      });

      setDisableConfirm(true);
      setCartData({
        ...cartData,
        order_id: response.order_id,
        token_id: response.token_id,
      });
      createECODOrder(
        {
          _d: { gateway: "razorpay" },
          order_id: response.order_id,
          token_id: response.token_id,
          payment_status: "PENDING",
        },
        orderData
      );
    };

    const linkCreationFailed = (orderInitiated, error) => {
      setChecks({
        ...retryDetails,
        ...params.retryDetails,
        orderInitiated: orderInitiated,
        actionStage: ActionStage.ERROR_CREATING_ECOD_PAYMENT_REQUEST,
        resumedPaymentData: { data: orderData },
      });

      setDisableConfirm(false);
      handleError(error);
    };

    showLoader(true);
    OrderApis.createLinkOrder(
      postData,
      (response) => {
        if (response.status) {
          linkCreationSuccess(response);
        } else {
          linkCreationFailed(false, response);
        }
      },
      (e) => {
        linkCreationFailed(true, e);
      }
    );
  };

  const handleSharePaymentLink = () => {
    const orderData = {
      application: "salespro",
      gateway: "razorpay",
      client: "salespro",
      ...checkoutData,
    };
    showLoader(true);
    orderData.data.device_details = orderData.data.device_details || {};
    props.publishConfirmation({
      confirmation: {
        title: t("linkpopup.title"),
        message: t("linkpopup.message"),
        buttons: {
          positiveButtonText: t("linkpopup.positive"),
          negativeButtonText: t("linkpopup.negative"),
          positiveButtonAction: () => {
            props.dismiss();
            setTimeout(() => {
              if (!disableConfirm) {
                CT_Sell.makePaymentShareLinkProceed();
                linkCreation(orderData);
              }
            }, 500);
          },
          negativeButtonAction: () => {
            showLoader(false);
            props.dismiss();
            CT_Sell.makePaymentShareLinkCancel();
          },
        },
      },
    });
  };

  // Process: Seller Wallet
  const showRzpForm = (rechargeAmount) => {
    CT_Sell.placeOrderRecharge();
    if (!rechargeAmount || isNaN(rechargeAmount)) {
      setErrorText(t("validation.rechargeamount"));
      return;
    } else if (rechargeAmount.includes(".")) {
      setErrorText("validation.integervalue");
      return;
    } else if (rechargeAmount > User.getRechargeLimit()) {
      setErrorText(t("validation.maxrecharge", { limit: User.getRechargeLimit() }));
      return;
    } else if (rechargeAmount < 1) {
      setErrorText(t("validation.ifzero"));
      return;
    }

    let options = {
      description: "Wallet Recharge", // Do not change
      currency: "INR",
      key: baseConfig.getCheckoutFormToken(),
      amount: rechargeAmount * 100, // As razorpay requires (amount in paisa)
      name: "Onsite Electro Services Pvt. Ltd.",
      prefill: {
        email: userInfo.outlet_email,
        contact: userInfo.outlet_phone,
        name: userInfo.outlet_name,
      },
      notes: {
        "User Extra": "wallet recharge",
        version: Config.VERSION_NAME,
        type: "single",
        registered_phone: userInfo.outlet_phone,
      },
      hidden: {
        contact: true,
        email: true,
      },
      theme: {
        hide_topbar: true,
      },
      readonly: {
        contact: true,
        email: true,
        name: true,
      },
    };

    CodePush.disallowRestart();
    RazorpayCheckout.open(options)
      .then((data) => ({
        paymentId: data.razorpay_payment_id,
        amount: rechargeAmount,
      }))
      .then((paymentData) => {
        paymentData.note = options.notes;
        UserWallet.loadWallet(
          paymentData,
          (response) => {
            let event_data = {};
            event_data.wallet_amount = walletBalance;
            event_data.recharge_amount = parseInt(rechargeAmount);
            event_data.txn_id = paymentData.paymentId;
            if (response.status == "AMOUNT_TRANSFERRED") {
              props.publishMessage({
                success: {
                  title: "Success",
                  message: t("rechargemessage", { rechargeAmount: rechargeAmount }),
                },
              });
              setPaymentMethod(PAYMENT_MODE.SELLER_WALLET);
              setWalletBalance(walletBalance + parseInt(inputText));
              setErrorText(null);
            } else {
              handleError(loadWalletError2);
              event_data.error = response.status;
            }
            setAPIInProgress(true);
            disablePayButton(true);
            setWalletRechargePaymentDone(true);
            fetchBalance();
          },
          (error) => {
            handleError(loadWalletError2);
          }
        );
      })
      .catch((e) => {
        if (e.error.code === "BAD_REQUEST_ERROR") {
          e.error.code = t("errors.tryagain");
        }
        handleError(e);
      });
  };

  // Process: CP Wallet
  const requestCredits = () => {
    let requestAmount = inputTextCP;
    let maxAllowed =
      creditWalletInfo.credit_limit - creditWalletInfo.balance + parseInt(requestAmount);
    maxAllowed = maxAllowed < 0 ? 0 : maxAllowed;

    if (!requestAmount || isNaN(requestAmount)) {
      setErrorTextCP(t("validation.rechargeamount"));
      return;
    } else if (requestAmount.includes(".")) {
      setErrorTextCP("validation.integervalue");
      return;
    } else if (parseInt(requestAmount) > maxAllowed) {
      setErrorTextCP(t("validation.maxrecharge", { limit: maxAllowed }));
      return;
    }

    const initiateRequest = () => {
      DistributorApis.transferCreditsRequest(
        {
          retailer_id: userInfo.outlet_id,
          registered_phone: userInfo.outlet_phone,
          gateway: "onsitego",
          transfer_amount: parseInt(requestAmount),
          transfer_type: "CPR",
          notes: {
            "recharge request from": userInfo.outlet_name,
          },
        },
        (response) => {
          if (response.status === "AMOUNT_TRANSFERRED") {
            setCPRInProgress(true);
            setCPRRaised(true);
            setCpPayDisabled(true);
            setCPAPIInProgress(true);
            observeRequestStatus(response.retailer_payment_transfer_ids[0]);

            props.publishMessage({
              success: {
                title: t("desc.message.requested"),
                message: `₹${requestAmount} ${t("desc.message.requested_message")}`,
                cancellable: true,
                style: { backgroundColor: colors.secondary },
              },
            });
          } else if (response.error && response.error.code === "Request pending") {
            setCPRInProgress(true);
            setCPRRaised(true);
            setCpPayDisabled(true);
            setCPAPIInProgress(true);
            observeRequestStatus(response.retailer_payment_transfer_ids[0]);

            handleError({
              info: { message: t("desc.message.pending") },
            });
          } else {
            handleError({
              error: { message: t("desc.message.pending") },
            });
            setCPRInProgress(false);
            fetchCPWalletBalance();
          }
        },
        (err) => {
          setCPRInProgress(false);
          handleError(err);
        }
      );
    };

    props.publishConfirmation({
      confirmation: {
        title: "Confirm title",
        message: "Confirm msg",
        buttons: {
          positiveButtonText: "Yes",
          negativeButtonText: "No",
          positiveButtonAction: () => {
            props.dismiss();
            // TODO: here loading icon in payment balance must be visible, also pending status of requiest
            initiateRequest();
          },
          negativeButtonAction: () => {
            showLoader(false);
            props.dismiss();
          },
        },
      },
    });
  };

  // Process : CP Wallet
  const observeRequestStatus = async (request_id) => {
    return await DistributorApis.getRequestStatus({
      request_ids: [request_id],
      retailer_token: userInfo.retailer_token,
    })
      .then((response) => {
        let request = response.requests.find((r) => r.id == request_id);
        if (request) {
          switch (request.status) {
            case "success":
            case "approved":
              // if request status is successfull then we can just check the balance,
              // and act as per latest balance
              fetchCPWalletBalance();
              break;
            case "pending":
              // is the request status is in pending status
              // we will be polling for same request again (infinite)
              let timer = setTimeout(() => {
                clearTimeout(timer);
                observeRequestStatus(request_id);
              }, DURATION.LONG * 1000);
              break;
            default:
              // rejection/failure
              // in this case we will just fetch latest balance and update UI
              setCPRRaised(false);
              fetchCPWalletBalance();
              break;
          }
        } else {
          setCPRRaised(false);
          fetchCPWalletBalance();
        }
      })
      .catch((error) => {
        setCPRRaised(false);
        fetchCPWalletBalance();
        handleError(error);
      });
  };

  const { orderInitiated, actionStage } = params.retryDetails ? params.retryDetails : retryDetails;

  return (
    <SafeAreaView edges={["left", "right"]} style={styles.mainContainer}>
      {!orderInitiated ? (
        <View style={styles.container}>
          <Text style={styles.heading} bold>
            {t("title")}
          </Text>

          {(walletRechargePaymentDone && rechargeInProgress && canPayFromWallet) ||
          (cprRaised && cprInProgress && canPayFromCPWallet) ? (
            <View style={styles.timer}>
              <Timer
                duration={Duration}
                callback={() => {
                  switch (paymentMethod) {
                    case PAYMENT_MODE.SELLER_WALLET:
                      setAPIInProgress(true);
                      fetchBalance();
                      break;
                    case PAYMENT_MODE.CP_WALLET:
                      // NOTE: this component is not getting used for CP Walet CPR
                      // API loader will be called in the method
                      // fetchCPWalletBalance();
                      break;
                  }
                }}
              />
            </View>
          ) : null}

          {/* Seller Wallet UI */}
          {canPayFromWallet && (
            <PaymentOption
              paymentMethod={paymentMethod}
              type={PAYMENT_MODE.SELLER_WALLET}
              onPress={setPaymentMethod}
            >
              <View style={styles.flex}>
                <View style={styles.middleTextView}>
                  <Text style={styles.middleTextHeading}>{t("wallet.title")}</Text>
                  {canSeeWalletBalance ? (
                    <>
                      <View style={styles.middleViewContent}>
                        <Text style={styles.middleTextContent}>{t("wallet.totalamt")} </Text>
                        {apiInProgress || rechargeInProgress ? (
                          <ActivityIndicator color={colors.accent} size={16} />
                        ) : (
                          <Text style={styles.middleTextContent}>
                            {currencyFormatter.format(walletBalance)}
                          </Text>
                        )}
                      </View>
                      {apiInProgress && payButtonDisabled && walletRechargePaymentDone ? (
                        <Text style={styles.rechargeInProcess}>
                          {t("wallet.recharge", { inputText: inputText })}
                        </Text>
                      ) : null}
                    </>
                  ) : null}
                  {errorText && !rechargeInProgress && (
                    <Text style={styles.errorText}>{errorText}</Text>
                  )}
                </View>

                <View style={styles.optionIconContainer}>
                  <Image source={icons.ic_wallet} style={styles.walletImage} />
                </View>
              </View>

              {paymentMethod === PAYMENT_MODE.SELLER_WALLET ? (
                <>
                  {hasRechargePermission &&
                  (errorText !== null || walletBalance < cartTotalAmount) ? (
                    <InputToolbar
                      inputText={inputText}
                      onSubmit={showRzpForm}
                      setInputText={setInputText}
                      submitText={t("wallet.rechargewallet")}
                    />
                  ) : null}

                  <TouchableOpacity
                    activeOpacity={0.9}
                    disabled={payButtonDisabled}
                    onPress={handlePaymentWallet}
                    style={[styles.payButton, payButtonDisabled && styles.payButtonDisabled]}
                  >
                    <Text bold style={styles.bttnText}>
                      {t("wallet.pay")}
                      {"  "}
                      {currencyFormatter.format(cartTotalAmount)}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </PaymentOption>
          )}

          {/* CP Wallet UI */}
          {canPayFromCPWallet && (
            <PaymentOption
              paymentMethod={paymentMethod}
              disabled={creditWalletInfo.disabled} // In case wallet is disabled from backend
              type={PAYMENT_MODE.CP_WALLET}
              onPress={setPaymentMethod}
            >
              <View style={styles.flex}>
                <View style={styles.middleTextView}>
                  <Text style={styles.middleTextHeading}>{t("cpmiddletext")}</Text>
                  <View style={styles.middleViewContent}>
                    <Text style={styles.middleTextContent}>{`${t("cpbalance")} `}</Text>
                    {cpApiInProgress || cprRaised ? (
                      <ActivityIndicator color={colors.accent} size={16} />
                    ) : (
                      <Text style={styles.middleTextContent}>
                        {`${currencyFormatter.format(creditWalletInfo.balance)}`}
                      </Text>
                    )}
                  </View>
                  <View style={styles.middleViewContent}>
                    <Text style={styles.middleTextContent}>
                      {t("cplimit", {
                        value: currencyFormatter.format(creditWalletInfo.credit_limit),
                      })}
                    </Text>
                  </View>
                  {cprRaised ? (
                    <Text style={styles.rechargeInProcess}>
                      {t("wallet.pending_credit_request", { inputText: inputText })}
                    </Text>
                  ) : null}
                  {!cprRaised && errorTextCP && <Text style={styles.errorText}>{errorTextCP}</Text>}
                </View>

                <View style={styles.optionIconContainer}>
                  <Image source={icons.ic_credit} style={styles.walletImage} />
                </View>
              </View>

              {paymentMethod === PAYMENT_MODE.CP_WALLET ? (
                <>
                  {creditWalletInfo.is_own_cp_wallet &&
                  !cprRaised &&
                  (errorTextCP !== null || creditWalletInfo.balance < cartTotalAmount) ? (
                    <InputToolbar
                      inputText={inputTextCP}
                      onSubmit={() => {
                        // TODO: do we need confirmation here ?
                        // for super credit wallet this user cannot raise request so UI must handle that
                        requestCredits();
                      }}
                      setInputText={setInputTextCP}
                      submitText={t("wallet.request_credit")}
                    />
                  ) : null}

                  <TouchableOpacity
                    activeOpacity={0.9}
                    disabled={cpPayDisabled}
                    onPress={handlePaymentCPWallet}
                    style={[styles.payButton, cpPayDisabled && styles.payButtonDisabled]}
                  >
                    <Text bold style={styles.bttnText}>
                      {t("wallet.pay")}
                      {"  "}
                      {currencyFormatter.format(cartTotalAmount)}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </PaymentOption>
          )}

          {/* Share Payment Link UI */}
          {canPayUsingLink && (
            <PaymentOption
              paymentMethod={paymentMethod}
              type={PAYMENT_MODE.LINK}
              onPress={setPaymentMethod}
            >
              <View style={styles.flex}>
                <View style={styles.middleTextView}>
                  <Text style={styles.middleTextHeading}>{t("usinglink.title")}</Text>
                  <Text style={styles.middleTextContent}>{t("usinglink.middletext")}</Text>
                </View>

                <View style={styles.optionIconContainer}>
                  <Image source={icons.ic_user} style={styles.walletImage} />
                </View>
              </View>

              {paymentMethod == PAYMENT_MODE.LINK ? (
                <TouchableOpacity
                  activeOpacity={0.9}
                  onPress={handleSharePaymentLink}
                  style={styles.payButton}
                >
                  <Text bold style={styles.bttnText}>
                    {t("usinglink.buttontext")}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </PaymentOption>
          )}
        </View>
      ) : (
        <OrderRetry
          config={retryDetails}
          isLoading={props.isLoading}
          actionStage={actionStage}
          retryAction={() => resumeOrderPlacement()}
          t={t}
        />
      )}
    </SafeAreaView>
  );
}

const mapDispatchToProps = (dispatch) => ({
  sucessResetCart: () => dispatch(sucessResetCart()),
});

const mapStateToProps = (state) => ({
  cart: state.cartInfo.cart,
  isLoading: state.loadingScreen.isLoading,
});

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(withPageTranslator("payment", basicModification(Payment)));

const styles = StyleSheet.create({
  heading: {
    fontFamily: "Montserrat-SemiBold",
    fontSize: 13,
    marginTop: 10,
    marginBottom: 8,
    marginHorizontal: 16,
  },
  payButtonDisabled: {
    backgroundColor: "#C1EFEC",
  },
  timer: {
    padding: 4,
    backgroundColor: "red",
    display: "none",
  },
  container: {
    backgroundColor: "#FFFFFF",
    height: "100%",
  },
  payButton: {
    backgroundColor: "#15939A",
    paddingVertical: 12,
    marginRight: 16,
    marginTop: 8,
    alignItems: "center",
    borderRadius: 6,
    marginBottom: 6,
  },
  bttnText: {
    color: "white",
    fontFamily: "Montserrat-Bold",
    fontSize: 13,
  },
  flex: {
    flexDirection: "row",
    paddingRight: 16,
    alignItems: "center",
    justifyContent: "space-evenly",
    minHeight: 50,
  },
  optionIconContainer: {
    height: 38,
    width: 38,
    borderRadius: 19,
    borderWidth: 0.5,
    borderColor: v1.colors.text4,
    justifyContent: "center",
    alignItems: "center",
  },
  walletImage: {
    height: 22,
    width: 22,
  },
  middleTextView: {
    marginRight: 12,
    marginLeft: 4,
    flex: 1,
    justifyContent: "center",
  },
  middleTextHeading: {
    fontFamily: "Montserrat-SemiBold",
    fontSize: 13,
  },
  middleViewContent: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
  },
  middleTextContent: {
    fontSize: 13,
  },
  mainContainer: {
    backgroundColor: "#f1f1fc",
  },
  errorText: {
    color: v1.colors.semantics1,
    fontSize: 12,
    width: "95%",
  },
  rechargeInProcess: {
    color: "#FDA000",
    fontSize: 11,
    fontFamily: "Montserrat-SemiBold",
  },
});
